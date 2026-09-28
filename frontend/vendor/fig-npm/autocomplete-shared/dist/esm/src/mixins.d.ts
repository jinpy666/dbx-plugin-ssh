/// <reference types="@withfig/autocomplete-types" />
export declare type SpecMixin = Fig.Subcommand | ((currentSpec: Fig.Subcommand, context: Fig.ShellContext) => Fig.Subcommand);
export declare function mergeSubcommands(subcommand: Fig.Subcommand, partial: Fig.Subcommand): Fig.Subcommand;
export declare const applyMixin: (spec: Fig.Subcommand, context: Fig.ShellContext, mixin: SpecMixin) => Fig.Subcommand;
