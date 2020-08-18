
// Here be dragons

const next: any = (regen: any, ...args: any) => (data: any) => {
    const gen = regen(...args);
    return gen.next(data), gen;
};

const immutagen: any = (regen: any) => (...args: any) => function loop(regen: any): any {
    return (gen: any, data: any) => {
        const {value, done} = gen.next(data);
        if (done) return {value, next: null};

        let replay = false;
        const recur = loop(next(regen, data));
        return {value, next: (value: any) => {
            if (replay) return recur(regen(data), value);
            replay = true; return recur(gen, value);
        }};
    };
}(next(regen, ...args))(regen(...args));

const monad = (bind: any) => (regen: any) => (...args: any) => function loop({value, next}) {
    return next ? bind(value, (val: any) => loop(next(val))) : value;
}(immutagen(regen)(...args));

// notably, the `any` return type here wrecks type
// safety, but I'm not sure how to fix it
export const makeParser: any = monad((parser: any, callback: any) => parser.then(callback))

// run a parser and print its result / remaining input
export const test = (p: { run: (_: string) => [any,string] | null }, input: string) => {
    const result = p.run(input)
    if (result) {
        const [val,remaining] = result
        console.log("------------- result")
        console.log(JSON.stringify(val, null, 2))
        console.log("------------- remaining")
        console.log(remaining)
    } else {
        console.log("parse failed")
    }
}

