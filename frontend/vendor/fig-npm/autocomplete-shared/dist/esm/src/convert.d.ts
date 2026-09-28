/// <reference types="@withfig/autocomplete-types" />
export declare type SuggestionType = Fig.SuggestionType | "history" | "auto-execute";
declare type Override<T, S> = Omit<T, keyof S> & S;
export declare type Suggestion = Override<Fig.Suggestion, {
    type?: SuggestionType;
}>;
export declare type Option<ArgT, OptionT> = OptionT & {
    name: string[];
    args: ArgT[];
};
export declare type Subcommand<ArgT, OptionT, SubcommandT> = SubcommandT & {
    name: string[];
    subcommands: Record<string, Subcommand<ArgT, OptionT, SubcommandT>>;
    options: Record<string, Option<ArgT, OptionT>>;
    persistentOptions: Record<string, Option<ArgT, OptionT>>;
    args: ArgT[];
};
export declare type Initializer<ArgT, OptionT, SubcommandT> = {
    subcommand: (subcommand: Fig.Subcommand) => SubcommandT;
    option: (option: Fig.Option) => OptionT;
    arg: (arg: Fig.Arg) => ArgT;
};
export declare function convertSubcommand<ArgT, OptionT, SubcommandT>(subcommand: Fig.Subcommand, initialize: Initializer<ArgT, OptionT, SubcommandT>): Subcommand<ArgT, OptionT, SubcommandT>;
export {};
