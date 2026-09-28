"use strict";
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeDefault = exports.convertLoadSpec = void 0;
const convert_1 = require("./convert");
const utils_1 = require("./utils");
function convertLoadSpec(loadSpec, initialize) {
    if (typeof loadSpec === "string") {
        return [{ name: loadSpec, type: utils_1.SpecLocationSource.GLOBAL }];
    }
    if (typeof loadSpec === "function") {
        return (...args) => loadSpec(...args).then((result) => {
            if (Array.isArray(result)) {
                return result;
            }
            if ("type" in result) {
                return [result];
            }
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            return (0, convert_1.convertSubcommand)(result, initialize);
        });
    }
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    return (0, convert_1.convertSubcommand)(loadSpec, initialize);
}
exports.convertLoadSpec = convertLoadSpec;
function initializeOptionMeta(option) {
    return option;
}
// Default initialization functions:
function initializeArgMeta(arg) {
    var _a;
    const { template } = arg, rest = __rest(arg, ["template"]);
    const generators = template ? [{ template }] : (0, utils_1.makeArray)((_a = arg.generators) !== null && _a !== void 0 ? _a : []);
    return Object.assign(Object.assign({}, rest), { loadSpec: arg.loadSpec
            ? convertLoadSpec(arg.loadSpec, {
                option: initializeOptionMeta,
                // eslint-disable-next-line @typescript-eslint/no-use-before-define
                subcommand: initializeSubcommandMeta,
                arg: initializeArgMeta,
            })
            : undefined, generators: generators.map((generator) => {
            let { trigger, getQueryTerm } = generator;
            if (generator.template) {
                const templates = (0, utils_1.makeArray)(generator.template);
                if (templates.includes("folders") || templates.includes("filepaths")) {
                    trigger = trigger !== null && trigger !== void 0 ? trigger : "/";
                    getQueryTerm = getQueryTerm !== null && getQueryTerm !== void 0 ? getQueryTerm : "/";
                }
            }
            return Object.assign(Object.assign({}, generator), { trigger, getQueryTerm });
        }) });
}
function initializeSubcommandMeta(subcommand) {
    return Object.assign(Object.assign({}, subcommand), { loadSpec: subcommand.loadSpec
            ? convertLoadSpec(subcommand.loadSpec, {
                subcommand: initializeSubcommandMeta,
                option: initializeOptionMeta,
                arg: initializeArgMeta,
            })
            : undefined });
}
exports.initializeDefault = {
    subcommand: initializeSubcommandMeta,
    option: initializeOptionMeta,
    arg: initializeArgMeta,
};
//# sourceMappingURL=specMetadata.js.map