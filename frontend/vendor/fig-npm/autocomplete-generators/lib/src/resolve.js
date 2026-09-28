"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shellExpand = exports.ensureTrailingSlash = void 0;
const ensureTrailingSlash = (str) => (str.endsWith("/") ? str : `${str}/`);
exports.ensureTrailingSlash = ensureTrailingSlash;
const replaceTilde = (path, homeDir) => {
    if (path.startsWith("~") && (path.length === 1 || path.charAt(1) === "/")) {
        return path.replace("~", homeDir);
    }
    return path;
};
const replaceVariables = (path, environmentVariables) => {
    // Replace simple $VAR variables
    const resolvedSimpleVariables = path.replace(/\$([A-Za-z0-9_]+)/g, (key) => {
        var _a;
        const envKey = key.slice(1);
        return (_a = environmentVariables[envKey]) !== null && _a !== void 0 ? _a : key;
    });
    // Replace complex ${VAR} variables
    const resolvedComplexVariables = resolvedSimpleVariables.replace(/\$\{([A-Za-z0-9_]+)(?::-([^}]+))?\}/g, (match, envKey, defaultValue) => { var _a, _b; return (_b = (_a = environmentVariables[envKey]) !== null && _a !== void 0 ? _a : defaultValue) !== null && _b !== void 0 ? _b : match; });
    return resolvedComplexVariables;
};
const shellExpand = (path, context) => {
    var _a;
    const { environmentVariables } = context;
    return replaceVariables(replaceTilde(path, (_a = environmentVariables === null || environmentVariables === void 0 ? void 0 : environmentVariables.HOME) !== null && _a !== void 0 ? _a : "~"), environmentVariables);
};
exports.shellExpand = shellExpand;
