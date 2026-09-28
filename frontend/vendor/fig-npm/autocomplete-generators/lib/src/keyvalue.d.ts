/// <reference types="@withfig/autocomplete-types" />
/** Suggestions to be displayed for keys or values */
export declare type KeyValueSuggestions = string[] | Fig.Suggestion[] | NonNullable<Fig.Generator["custom"]>;
/** @deprecated use `KeyValueSuggestions` */
export declare type Suggestions = KeyValueSuggestions;
export declare type CacheValue = boolean | "keys" | "values";
export interface ValueListInit {
    /** String to use as the separator between keys and values */
    delimiter?: string;
    /** List of suggestions */
    values?: KeyValueSuggestions;
    /** Cache key and value suggestions */
    cache?: boolean;
    /** Insert the delimiter string after accepting a suggestion (default: false) */
    insertDelimiter?: boolean;
    /** Don't filter repeated values from suggestions (default: false) */
    allowRepeatedValues?: boolean;
}
export interface KeyValueInit {
    /** String to use as the separator between keys and values */
    separator?: string;
    /** List of key suggestions */
    keys?: KeyValueSuggestions;
    /** List of value suggestions */
    values?: KeyValueSuggestions;
    /** Cache key and value suggestions */
    cache?: CacheValue;
    /** Should the separator be inserted after a key? (default: true ) */
    insertSeparator?: boolean;
}
export interface KeyValueListInit {
    /** String to use as the separator between keys and values */
    separator?: string;
    /** String to use as the separator between key-value pairs */
    delimiter?: string;
    /** List of key suggestions */
    keys?: KeyValueSuggestions;
    /** List of value suggestions */
    values?: KeyValueSuggestions;
    /** Cache key and value suggestions */
    cache?: CacheValue;
    /** Should the separator be inserted after a key? (default: true ) */
    insertSeparator?: boolean;
    /** Insert the delimiter string after accepting a value suggestion (default: false) */
    insertDelimiter?: boolean;
    /** Don't filter repeated keys from suggestions (default: false) */
    allowRepeatedKeys?: boolean;
    /** Don't filter repeated values from suggestions (default: true) */
    allowRepeatedValues?: boolean;
}
/**
 * Create a generator that gives suggestions for val,val,... arguments. You
 * can use a `string[]` or `Fig.Suggestion[]` for the values.
 *
 * You can set `cache: true` to enable caching results. The suggestions are cached
 * globally using the function as a key, so enabling caching for any one generator
 * will set the cache values for the functions for the entire spec. This behavior
 * can be used to compose expensive generators without incurring a cost every time
 * they're used.
 *
 * The primary use of this is to enable the same caching behavior as `keyValue`
 * and `keyValueList`. If your goal is to create a $PATH-like value, use a generator
 * object literal: `{ template: "filepaths", trigger: ":", getQueryTerm: ":" }`
 */
export declare function valueList({ delimiter, values, cache, insertDelimiter, allowRepeatedValues, }: ValueListInit): Fig.Generator;
/**
 * Create a generator that gives suggestions for key=value arguments. You
 * can use a `string[]` or `Fig.Suggestion[]` for the keys and values, or a
 * function with the same signature as `Fig.Generator["custom"]`.
 *
 * You can set `cache: true` to enable caching results. The suggestions are cached
 * globally using the function as a key, so enabling caching for any one generator
 * will set the cache values for the functions for the entire spec. This behavior
 * can be used to copmpose expensive key/value generators without incurring the
 * initial cost every time they're used.
 *
 * Note that you should only cache generators that produce the same output regardless
 * of their input. You can cache either the keys or values individually using `"keys"`
 * or `"values"` as the `cache` property value.
 *
 * @example
 *
 * ```typescript
 * // set-values a=1 b=3 c=2
 * const spec: Fig.Spec = {
 *   name: "set-values",
 *   args: {
 *     name: "values",
 *     isVariadic: true,
 *     generators: keyValue({
 *       keys: ["a", "b", "c"],
 *       values: ["1", "2", "3"],
 *     }),
 *   },
 * }
 * ```
 *
 * @example The separator between keys and values can be customized (default: `=`)
 *
 * ```typescript
 * // key1:value
 * keyValue({
 *   separator: ":",
 *   keys: [
 *     { name: "key1", icon: "fig://icon?type=string" },
 *     { name: "key2", icon: "fig://icon?type=string" },
 *   ],
 * }),
 * ```
 */
export declare function keyValue({ separator, keys, values, cache, insertSeparator, }: KeyValueInit): Fig.Generator;
/**
 * Create a generator that gives suggestions for `k=v,k=v,...` arguments. You
 * can use a `string[]` or `Fig.Suggestion[]` for the keys and values, or a
 * function with the same signature as `Fig.Generator["custom"]`
 *
 * You can set `cache: true` to enable caching results. The suggestions are cached
 * globally using the function as a key, so enabling caching for any one generator
 * will set the cache values for the functions for the entire spec. This behavior
 * can be used to copmpose expensive key/value generators without incurring the
 * initial cost every time they're used.
 *
 * Note that you should only cache generators that produce the same output regardless
 * of their input. You can cache either the keys or values individually using `"keys"`
 * or `"values"` as the `cache` property value.
 *
 * @example
 *
 * ```typescript
 * // set-values a=1,b=3,c=2
 * const spec: Fig.Spec = {
 *   name: "set-values",
 *   args: {
 *     name: "values",
 *     generators: keyValueList({
 *       keys: ["a", "b", "c"],
 *       values: ["1", "2", "3"],
 *     }),
 *   },
 * }
 * ```
 *
 * @example
 *
 * The separator between keys and values can be customized. It's `=` by
 * default. You can also change the key/value pair delimiter, which is `,`
 * by default.
 *
 * ```typescript
 * // key1:value&key2:another
 * keyValueList({
 *   separator: ":",
 *   delimiter: "&"
 *   keys: [
 *     { name: "key1", icon: "fig://icon?type=string" },
 *     { name: "key2", icon: "fig://icon?type=string" },
 *   ],
 * }),
 * ```
 */
export declare function keyValueList({ separator, delimiter, keys, values, cache, insertSeparator, insertDelimiter, allowRepeatedKeys, allowRepeatedValues, }: KeyValueListInit): Fig.Generator;
