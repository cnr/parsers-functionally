import { makeParser, test } from './helpers'

//////////////////// Parser datatype and primitives

type ParseFn<A> =
    (_: string) => [A, string] | null

class Parser<A> {
    run: ParseFn<A>

    constructor(run: ParseFn<A>) {
        this.run = run
    }

    then<B>(next: (_: A) => Parser<B>): Parser<B> {
        return new Parser((input: string) => {
            const result = this.run(input)
            if (result) {
                const [a,remaining] = result
                const parserB: Parser<B> = next(a)
                return parserB.run(remaining)
            }
            return null
        })
    }

    static resolve<T>(val: T): Parser<T> {
        return new Parser((input: string) => [val, input])
    }
}

// always fails
const fail: Parser<any> =
    new Parser((input: string) => null)

// get a single character from the input, unconditionally
// fails on empty input
type char = string
const single: Parser<char> =
    new Parser((input: string) => {
        if (input === '') {
            return null
        }
        return [input.charAt(0),input.slice(1)]
    })

// try each parser in the array until one succeeds
function oneOf<A>(parsers: Array<Parser<A>>): Parser<A> {
    return new Parser((input: string) => {
        for (const parser of parsers) {
            const result = parser.run(input)
            if (result) {
                return result
            }
        }
        return null
    })
}

// parse a whole chunk of text, like "foo". this can be defined in terms of the
// other primitive parsers, but we don't do that here.
function chunk(str: string): Parser<string> {
    return new Parser((input: string) => {
        if (input.startsWith(str)) {
            return [str, input.slice(str.length)]
        }
        return null
    })
}

//////////////////// Library functions

// parse a single character from the input, and succeed if the predicate returns true
const satisfy = (predicate: (_: char) => boolean): Parser<char> =>
    single.then(c => {
        if (predicate(c)) {
            return Parser.resolve(c)
        }
        return fail
    })

// parse a specific character: char('c')
const char = (c: char): Parser<char> =>
    satisfy(c2 => c === c2)

// parse a digit
const digit: Parser<char> =
    satisfy(c => /[0-9]/.test(c))

// parse a letter
const letter: Parser<char> =
    satisfy(c => /[a-z]/i.test(c))

// parse a whitespace character
const space: Parser<char> =
    satisfy(c => /\s/.test(c))

// apply a parser one or more times, collecting the results
const oneOrMore = <A>(p: Parser<A>): Parser<Array<A>> =>
    p.then(one =>
        zeroOrMore(p).then(more => {
            more.unshift(one)
            return Parser.resolve(more)
        }))

// apply a parser one or more times, collecting the results
const zeroOrMore = <A>(p: Parser<A>): Parser<Array<A>> =>
    oneOf([
        oneOrMore(p),
        Parser.resolve([])
    ])

// not actually used anywhere: parse an integer as a number
const int: Parser<number> =
    oneOrMore(digit).then(digits => {
        // digits is an array of char
        const joined = digits.join('')
        const parsed = parseInt(joined)
        return Parser.resolve(parsed)
    })

// between the before and after parsers, run a middle parser and return its result value
// useful for things like parentheses: between(symbol("("), symbol(")"), someOtherParser)
// or quotes: between(symbol('"'), symbol('"'), someOtherParser)
const between = <A>(before: Parser<any>, after: Parser<any>, middle: Parser<A>): Parser<A> =>
    before.then(_ =>
        middle.then(result =>
            after.then(_ => Parser.resolve(result))))

// optionally parse something, returning a nullable result
const optional = <A>(p: Parser<A>): Parser<A | null> =>
    oneOf([
        p,
        Parser.resolve(null)
    ])


//////////////////// Gomod

// apply the parser and consume trailing whitespace
// e.g., token(char('f')).run("foo") === ["f","oo"]
// e.g., token(char('f')).run("f  oo") === ["f","oo"]
const token = <A>(p: Parser<A>): Parser<A> =>
    makeParser(function*() {
        const result = yield p
        yield zeroOrMore(space)

        return Parser.resolve(result)
    })()

// gomod statement types
type Statement
  = { type: 'Module', path: string }
  | { type: 'Require', pkg: string, version: string }
  | { type: 'Replace', oldPkg: string, newPkg: string, newVersion: string }

// a go.mod package name
const packageName: Parser<string> =
    token(
        oneOrMore(oneOf([
            letter,
            digit,
            char('.'),
            char('-'),
            char('+'),
            char('/')
        ]))
    ).then(array => Parser.resolve(array.join(''))) // flatten the array of chars into a string

// a go.mod package version -- lazily aliased to packageName here
const semver: Parser<string> = packageName

// go.mod module statement: module example.com/foo/bar
const moduleStatement: Parser<Statement> =
    makeParser(function*() {
        yield token(chunk("module"))
        const path = yield token(packageName)

        return Parser.resolve({ type: 'Module', path })
    })()

// a helper for standalone statements OR a block of statements, e.g.,
//
//     require (
//         foo v1
//         bar v2
//     )
//
//     require baz v3
//
// the `prefix` would be "require", and `bodyParser` would parse the package name and version
//
// returns an array of results
const block = (prefix: string, bodyParser: Parser<Statement>): Parser<Array<Statement>> =>
    makeParser(function*() {
        yield token(chunk(prefix))
        return oneOf([
            bodyParser.then(single => Parser.resolve([single])),
            between(token(chunk('(')), token(chunk(')')), zeroOrMore(bodyParser))
        ])
    })()

// the "body" of a require statement: pkgName v1
const requireBody: Parser<Statement> =
    makeParser(function*() {
        const pkg = yield token(packageName)
        const version = yield token(packageName)

        return Parser.resolve({ type: 'Require', pkg, version })
    })()


// the "body" of a replace statement: fromPkg v1 => toPkg v2
// the "from version" is optional
const replaceBody: Parser<Statement> =
    makeParser(function*() {
        const fromPkg = yield token(packageName)
        yield token(optional(semver))

        yield token(chunk("=>"))

        const toPkg = yield token(packageName)
        const toVersion = yield token(semver)

        return Parser.resolve({ type: 'Replace', fromPkg, toPkg, toVersion })
    })()

// require statements
const requires: Parser<Array<Statement>> =
    block("require", requireBody)

// replace statements
const replaces: Parser<Array<Statement>> =
    block("replace", replaceBody)


// the top-level gomod parser: ignore leading whitespace, and parse zero or more
// statements
const gomod: Parser<Array<Statement>> =
    makeParser(function*() {
        yield zeroOrMore(space)

        return zeroOrMore(oneOf([
            requires,
            replaces,
            moduleStatement.then(single => Parser.resolve([single])),
        ])).then(array => Parser.resolve(array.flat()))
    })()

const example = `
module github.com/foo/bar

require foo v1
require (
	bar v2
	baz v3
)

replace foo v1 => foo v2
replace bar => baz v3
`

test(gomod, example)


//////////////////// bonus partial json parser

/*
// ----- stubs
// apply a parser zero or more times with a delimiter, e.g., sepBy(symbol("foo"), symbol(","))
// would be able to parse "foo,foo  ,  foo" and "foo"
const sepBy = <A>(thing: Parser<A>, separator: Parser<any>): Parser<Array<A>> => fail

const jsonStringRaw: Parser<string> = fail

const symbol = (str: string): Parser<string> => token(chunk(str))
const pairsToMap = (pairs: Array<[string,JsonValue]>): Map<string,JsonValue> => new Map()

const keyValuePair: Parser<[string,JsonValue]> =
    jsonStringRaw.then(key =>
        jsonValue.then(value =>
            Parser.resolve([key,value])))

type JsonValue = Map<string,JsonValue> | Array<JsonValue> | string | number | null

const jsonObject: Parser<JsonValue> =
    between(symbol('{'), symbol('}'), sepBy(keyValuePair, symbol(","))).then(pairs => Parser.resolve(pairsToMap(pairs)))

const jsonArray: Parser<JsonValue> =
    between(symbol('['), symbol(']'), zeroOrMore(jsonValue))

const jsonString: Parser<JsonValue> =
    between(symbol('"'), symbol('"'), zeroOrMore(satisfy(c => c !== '"')))

const jsonNull: Parser<null> =
    symbol("null").then(_ => Parser.resolve(null))

const jsonValue: Parser<JsonValue> =
    oneOf([
        jsonObject,
        jsonArray,
        jsonString,
        jsonNull
    ])
*/
