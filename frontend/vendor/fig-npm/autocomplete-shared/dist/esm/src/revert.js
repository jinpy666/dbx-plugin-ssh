function makeSingleOrArray(arr) {
    return arr.length === 1 ? arr[0] : arr;
}
function revertOption(option) {
    const { name, args } = option;
    return {
        name: makeSingleOrArray(name),
        args,
    };
}
export function revertSubcommand(subcommand, postProcessingFn) {
    const { name, subcommands, options, persistentOptions, args } = subcommand;
    const newSubcommand = {
        name: makeSingleOrArray(name),
        subcommands: Object.values(subcommands).length !== 0
            ? Object.values(subcommands).map((sub) => revertSubcommand(sub, postProcessingFn))
            : undefined,
        options: Object.values(options).length !== 0
            ? [
                ...Object.values(options).map((option) => revertOption(option)),
                ...Object.values(persistentOptions).map((option) => revertOption(option)),
            ]
            : undefined,
        args: Object.values(args).length !== 0 ? makeSingleOrArray(Object.values(args)) : undefined,
    };
    return postProcessingFn(subcommand, newSubcommand);
}
//# sourceMappingURL=revert.js.map