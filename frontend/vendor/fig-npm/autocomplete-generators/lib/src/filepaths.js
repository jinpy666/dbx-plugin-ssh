"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.filepaths = exports.folders = exports.getCurrentInsertedDirectory = exports.sortFilesAlphabetically = void 0;
const resolve_1 = require("./resolve");
function sortFilesAlphabetically(array, skip = []) {
    const skipLower = skip.map((str) => str.toLowerCase());
    const results = array.filter((x) => !skipLower.includes(x.toLowerCase()));
    // Put all files beginning with . after all those that don't, sort alphabetically within each.
    return [
        ...results.filter((x) => !x.startsWith(".")).sort((a, b) => a.localeCompare(b)),
        ...results.filter((x) => x.startsWith(".")).sort((a, b) => a.localeCompare(b)),
        "../",
    ];
}
exports.sortFilesAlphabetically = sortFilesAlphabetically;
/**
 * @param cwd - The current working directory when the user started typing the new path
 * @param searchTerm - The path inserted by the user, it can be relative to cwd or absolute
 * @returns The directory the user inserted, taking into account the cwd.
 */
const getCurrentInsertedDirectory = (cwd, searchTerm, context) => {
    if (cwd === null)
        return "/";
    const resolvedPath = (0, resolve_1.shellExpand)(searchTerm, context);
    const dirname = resolvedPath.slice(0, resolvedPath.lastIndexOf("/") + 1);
    if (dirname === "") {
        return (0, resolve_1.ensureTrailingSlash)(cwd);
    }
    return dirname.startsWith("/") ? dirname : `${(0, resolve_1.ensureTrailingSlash)(cwd)}${dirname}`;
};
exports.getCurrentInsertedDirectory = getCurrentInsertedDirectory;
/**
 * Sugar over using the `filepaths` template with `filterTemplateSuggestions`. If any of the
 * conditions match, the suggestion will be accepted.
 *
 * Basic filepath filters can be replaced with this generator.
 *
 * @example
 * ```
 * // inside a `Fig.Arg`...
 * generators: filepaths({ extensions: ["mjs", "js", "json"] });
 * ```
 */
function filepathsFn(options = {}) {
    const { extensions = [], equals = [], matches, filterFolders = false, editFileSuggestions, editFolderSuggestions, rootDirectory, showFolders = "always", } = options;
    // TODO: automatically remove eventual leading dots
    const extensionsSet = new Set(extensions);
    const equalsSet = new Set(equals);
    // NOTE: If no filter is provided we should not run the filterSuggestions fn.
    // !! When new filtering parameters are added we should increase this function
    const shouldFilterSuggestions = () => extensions.length > 0 || equals.length > 0 || matches;
    const filterSuggestions = (suggestions = []) => {
        if (!shouldFilterSuggestions())
            return suggestions;
        return suggestions.filter(({ name = "", type }) => {
            if (!filterFolders && type === "folder")
                return true;
            if (equalsSet.has(name))
                return true;
            if (matches && !!name.match(matches))
                return true;
            // handle extensions
            const [, ...suggestionExtensions] = name.split(".");
            if (suggestionExtensions.length >= 1) {
                let i = suggestionExtensions.length - 1;
                let stackedExtensions = suggestionExtensions[i];
                do {
                    if (extensionsSet.has(stackedExtensions)) {
                        return true;
                    }
                    i -= 1;
                    // `i` may become -1 which is not a valid index, but the extensionSet check at the beginning is not run in that case,
                    // so the wrong extension is not evaluated
                    stackedExtensions = [suggestionExtensions[i], stackedExtensions].join(".");
                } while (i >= 0);
            }
            return false;
        });
    };
    const postProcessSuggestions = (suggestions = []) => {
        if (!editFileSuggestions && !editFolderSuggestions)
            return suggestions;
        return suggestions.map((suggestion) => (Object.assign(Object.assign({}, suggestion), ((suggestion.type === "file" ? editFileSuggestions : editFolderSuggestions) || {}))));
    };
    return {
        trigger: (oldToken, newToken) => {
            const oldLastSlashIndex = oldToken.lastIndexOf("/");
            const newLastSlashIndex = newToken.lastIndexOf("/");
            // If the final path segment has changed, trigger new suggestions
            if (oldLastSlashIndex !== newLastSlashIndex) {
                return true;
            }
            // Here, there could either be no slashes, or something before the
            // final slash has changed. In the case where there are no slashes,
            // we don't want to trigger on each keystroke, so explicitly return false.
            if (oldLastSlashIndex === -1 && newLastSlashIndex === -1) {
                return false;
            }
            // We know there's at least one slash in the string thanks to the case
            // above, so trigger if anything before the final slash has changed.
            return oldToken.slice(0, oldLastSlashIndex) !== newToken.slice(0, newLastSlashIndex);
        },
        getQueryTerm: (token) => token.slice(token.lastIndexOf("/") + 1),
        custom: (_, executeCommand, generatorContext) => __awaiter(this, void 0, void 0, function* () {
            var _a;
            const { isDangerous, currentWorkingDirectory, searchTerm } = generatorContext;
            const currentInsertedDirectory = (_a = (0, exports.getCurrentInsertedDirectory)(rootDirectory !== null && rootDirectory !== void 0 ? rootDirectory : currentWorkingDirectory, searchTerm, generatorContext)) !== null && _a !== void 0 ? _a : "/";
            try {
                const data = yield executeCommand({
                    command: "ls",
                    args: ["-1ApL"],
                    cwd: currentInsertedDirectory,
                });
                const sortedFiles = sortFilesAlphabetically(data.stdout.split("\n"), [".DS_Store"]);
                const generatorOutputArray = [];
                // Then loop through them and add them to the generatorOutputArray
                // depending on the template type
                for (const name of sortedFiles) {
                    if (name) {
                        const templateType = name.endsWith("/") ? "folders" : "filepaths";
                        if ((templateType === "filepaths" && showFolders !== "only") ||
                            (templateType === "folders" && showFolders !== "never")) {
                            generatorOutputArray.push({
                                type: templateType === "filepaths" ? "file" : "folder",
                                name,
                                insertValue: name,
                                isDangerous,
                                context: { templateType },
                            });
                        }
                    }
                }
                // Filter suggestions. This takes in the array of suggestions, filters it,
                // and outputs an array of suggestions
                return postProcessSuggestions(filterSuggestions(generatorOutputArray));
            }
            catch (err) {
                return [];
            }
        }),
    };
}
exports.folders = Object.assign(() => filepathsFn({ showFolders: "only" }), Object.freeze(filepathsFn({ showFolders: "only" })));
exports.filepaths = Object.assign(filepathsFn, Object.freeze(filepathsFn()));
