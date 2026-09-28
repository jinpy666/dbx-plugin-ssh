/// <reference types="@withfig/autocomplete-types" />
import { Subcommand } from "./convert";
export declare function revertSubcommand<ArgT extends Fig.Arg, OptionT, SubcommandT>(subcommand: Subcommand<ArgT, OptionT, SubcommandT>, postProcessingFn: (oldSub: Subcommand<ArgT, OptionT, SubcommandT>, newSub: Fig.Subcommand) => Fig.Subcommand): Fig.Subcommand;
