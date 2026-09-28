import { makeArray } from "./utils";
const concatArrays = (a, b) => a && b ? [...a, ...b] : a || b;
const mergeNames = (a, b) => [
    ...new Set(concatArrays(makeArray(a), makeArray(b))),
];
const mergeArrays = (a, b) => a && b ? [...new Set(concatArrays(makeArray(a), makeArray(b)))] : a || b;
const mergeArgs = (arg, partial) => (Object.assign(Object.assign(Object.assign({}, arg), partial), { suggestions: concatArrays(arg.suggestions, partial.suggestions), generators: arg.generators && partial.generators
        ? concatArrays(makeArray(arg.generators), makeArray(partial.generators))
        : arg.generators || partial.generators, template: arg.template && partial.template
        ? mergeNames(arg.template, partial.template)
        : arg.template || partial.template }));
const mergeArgArrays = (args, partials) => {
    if (!args || !partials) {
        return args || partials;
    }
    const argArray = makeArray(args);
    const partialArray = makeArray(partials);
    const result = [];
    for (let i = 0; i < Math.max(argArray.length, partialArray.length); i += 1) {
        const arg = argArray[i];
        const partial = partialArray[i];
        if (arg !== undefined && partial !== undefined) {
            result.push(mergeArgs(arg, partial));
        }
        else if (partial !== undefined || arg !== undefined) {
            result.push(arg || partial);
        }
    }
    return result.length === 1 ? result[0] : result;
};
const mergeOptions = (option, partial) => (Object.assign(Object.assign(Object.assign({}, option), partial), { name: mergeNames(option.name, partial.name), args: mergeArgArrays(option.args, partial.args), exclusiveOn: mergeArrays(option.exclusiveOn, partial.exclusiveOn), dependsOn: mergeArrays(option.dependsOn, partial.dependsOn) }));
const mergeNamedObjectArrays = (objects, partials, mergeItems) => {
    if (!objects || !partials) {
        return objects || partials;
    }
    const mergedObjects = objects ? [...objects] : [];
    const existingNameIndexMap = {};
    for (let i = 0; i < objects.length; i += 1) {
        makeArray(objects[i].name).forEach((name) => {
            existingNameIndexMap[name] = i;
        });
    }
    for (let i = 0; i < partials.length; i += 1) {
        const partial = partials[i];
        if (!partial) {
            throw new Error("Invalid object passed to merge");
        }
        const existingNames = makeArray(partial.name).filter((name) => name in existingNameIndexMap);
        if (existingNames.length === 0) {
            mergedObjects.push(partial);
        }
        else {
            const index = existingNameIndexMap[existingNames[0]];
            if (existingNames.some((name) => existingNameIndexMap[name] !== index)) {
                throw new Error("Names provided for option matched multiple existing options");
            }
            mergedObjects[index] = mergeItems(mergedObjects[index], partial);
        }
    }
    return mergedObjects;
};
function mergeOptionArrays(options, partials) {
    return mergeNamedObjectArrays(options, partials, mergeOptions);
}
function mergeSubcommandArrays(subcommands, partials) {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    return mergeNamedObjectArrays(subcommands, partials, mergeSubcommands);
}
export function mergeSubcommands(subcommand, partial) {
    return Object.assign(Object.assign(Object.assign({}, subcommand), partial), { name: mergeNames(subcommand.name, partial.name), args: mergeArgArrays(subcommand.args, partial.args), additionalSuggestions: concatArrays(subcommand.additionalSuggestions, partial.additionalSuggestions), subcommands: mergeSubcommandArrays(subcommand.subcommands, partial.subcommands), options: mergeOptionArrays(subcommand.options, partial.options), parserDirectives: subcommand.parserDirectives && partial.parserDirectives
            ? Object.assign(Object.assign({}, subcommand.parserDirectives), partial.parserDirectives) : subcommand.parserDirectives || partial.parserDirectives });
}
export const applyMixin = (spec, context, mixin) => {
    if (typeof mixin === "function") {
        return mixin(spec, context);
    }
    const partial = mixin;
    return mergeSubcommands(spec, partial);
};
//# sourceMappingURL=mixins.js.map