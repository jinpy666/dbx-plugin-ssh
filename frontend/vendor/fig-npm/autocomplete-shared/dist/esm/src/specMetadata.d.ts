/// <reference types="@withfig/autocomplete-types" />
import { Subcommand, Initializer } from "./convert";
declare type FigLoadSpecFn = Fig.LoadSpec extends infer U ? (U extends Function ? U : never) : never;
export declare type LoadSpec<ArgT = ArgMeta, OptionT = OptionMeta, SubcommandT = SubcommandMeta> = Fig.SpecLocation[] | Subcommand<ArgT, OptionT, SubcommandT> | ((...args: Parameters<FigLoadSpecFn>) => Promise<Fig.SpecLocation[] | Subcommand<ArgT, OptionT, SubcommandT>>);
export declare type OptionMeta = Omit<Fig.Option, "args" | "name">;
export declare type ArgMeta = Omit<Fig.Arg, "template" | "generators" | "loadSpec"> & {
    generators: Fig.Generator[];
    loadSpec?: LoadSpec<ArgMeta, OptionMeta, SubcommandMeta>;
};
declare type SubcommandMetaExcludes = "subcommands" | "options" | "loadSpec" | "persistentOptions" | "args" | "name";
export declare type SubcommandMeta = Omit<Fig.Subcommand, SubcommandMetaExcludes> & {
    loadSpec?: LoadSpec<ArgMeta, OptionMeta, SubcommandMeta>;
};
export declare function convertLoadSpec<ArgT, OptionT, SubcommandT>(loadSpec: Fig.LoadSpec, initialize: Initializer<ArgT, OptionT, SubcommandT>): LoadSpec<ArgT, OptionT, SubcommandT>;
export declare const initializeDefault: Initializer<ArgMeta, OptionMeta, SubcommandMeta>;
export {};
