"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.convertSubcommand = void 0;
const utils_1 = require("./utils");
const makeNamedMap = (items) => {
    const nameMapping = {};
    if (!items) {
        return nameMapping;
    }
    for (let i = 0; i < items.length; i += 1) {
        items[i].name.forEach((name) => {
            nameMapping[name] = items[i];
        });
    }
    return nameMapping;
};
function convertOption(option, initialize) {
    return Object.assign(Object.assign({}, initialize.option(option)), { name: (0, utils_1.makeArray)(option.name), args: option.args ? (0, utils_1.makeArray)(option.args).map(initialize.arg) : [] });
}
function convertSubcommand(subcommand, initialize) {
    var _a, _b;
    const { subcommands, options, args } = subcommand;
    return Object.assign(Object.assign({}, initialize.subcommand(subcommand)), { name: (0, utils_1.makeArray)(subcommand.name), subcommands: makeNamedMap(subcommands === null || subcommands === void 0 ? void 0 : subcommands.map((s) => convertSubcommand(s, initialize))), options: makeNamedMap((_a = options === null || options === void 0 ? void 0 : options.filter((option) => !option.isPersistent)) === null || _a === void 0 ? void 0 : _a.map((option) => convertOption(option, initialize))), persistentOptions: makeNamedMap((_b = options === null || options === void 0 ? void 0 : options.filter((option) => option.isPersistent)) === null || _b === void 0 ? void 0 : _b.map((option) => convertOption(option, initialize))), args: args ? (0, utils_1.makeArray)(args).map(initialize.arg) : [] });
}
exports.convertSubcommand = convertSubcommand;
//# sourceMappingURL=convert.js.map