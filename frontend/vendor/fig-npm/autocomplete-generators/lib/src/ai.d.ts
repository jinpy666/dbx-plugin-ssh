/// <reference types="@withfig/autocomplete-types" />
export declare type GeneratorFn<T> = (args: {
    tokens: string[];
    executeCommand: Fig.ExecuteCommandFunction;
    generatorContext: Fig.GeneratorContext;
}) => Promise<T> | T;
/**
 * A generator that uses the Fig AI API to generate suggestions.
 *
 * @param prompt The prompt to use for the AI. Can be a string or a generator function.
 * @param message The message to send to the AI. Can be a string or a generator function.
 * @param postProcess A function to post-process the AI's response.
 * @param temperature The temperature to use for the AI.
 * @returns A Fig generator.
 */
export declare function ai({ name, prompt, message, postProcess, temperature, splitOn, }: {
    name: string;
    prompt?: string | GeneratorFn<string>;
    message: string | GeneratorFn<string | null> | null;
    postProcess?: (out: string) => Fig.Suggestion[];
    temperature?: number;
    splitOn?: string;
}): Fig.Generator;
