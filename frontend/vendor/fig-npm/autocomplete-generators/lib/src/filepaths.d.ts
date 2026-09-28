/// <reference types="@withfig/autocomplete-types" />
export interface FilepathsOptions {
    /**
     * Show suggestions with any of these extensions. Do not include the leading dot.
     */
    extensions?: string[];
    /**
     * Show suggestions where the name exactly matches one of these strings
     */
    equals?: string | string[];
    /**
     * Show suggestions where the name matches this expression
     */
    matches?: RegExp;
    /**
     * Will treat folders like files, filtering based on the name.
     */
    filterFolders?: boolean;
    /**
     * Set properties of suggestions of type "file".
     */
    editFileSuggestions?: Omit<Fig.Suggestion, "name" | "type">;
    /**
     * Set properties of suggestions of type "folder".
     */
    editFolderSuggestions?: Omit<Fig.Suggestion, "name" | "type">;
    /**
     * Start to suggest filepaths and folders from this directory.
     */
    rootDirectory?: string;
    /**
     * Set how the generator should display folders:
     * - **Default:** `always` will always suggest folders.
     * - `never`: will never suggest folders.
     * - `only`: will show only folders and no files.
     */
    showFolders?: "always" | "never" | "only";
}
export declare function sortFilesAlphabetically(array: string[], skip?: string[]): string[];
/**
 * @param cwd - The current working directory when the user started typing the new path
 * @param searchTerm - The path inserted by the user, it can be relative to cwd or absolute
 * @returns The directory the user inserted, taking into account the cwd.
 */
export declare const getCurrentInsertedDirectory: (cwd: string | null, searchTerm: string, context: Fig.ShellContext) => string;
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
declare function filepathsFn(options?: FilepathsOptions): Fig.Generator;
export declare const folders: (() => Fig.Generator) & Readonly<Fig.Generator>;
export declare const filepaths: typeof filepathsFn & Readonly<Fig.Generator>;
export {};
