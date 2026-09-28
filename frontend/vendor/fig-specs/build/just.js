//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/just.ts
/**
* Get the path of the justfile from an array of tokens.
*
* If no overriding flag is provided, `null` will be returned.
*
* Flags can be provided in any of these forms, and the regex to match this is
* about as ugly as you'd expect.
* - `-f name`
* - `-fname`
* - `-XYZfname` (short options before `f`, where `XYZ` are any non-f letters)
* - `-f=name`
* - `--justfile name`
* - `--justfile=name`
*/
function getJustfilePath(tokens) {
	const flagRe = /^(-[A-Za-eg-z]*f=?|--justfile(?:=|$))/;
	for (const [index, token] of tokens.entries()) {
		const match = token.match(flagRe);
		if (match === null) continue;
		const withoutOption = token.slice(match[1].length);
		if (withoutOption === "") return tokens[index + 1];
		return withoutOption;
	}
	return null;
}
/**
* Get the command to dump the justfile at the given path, or let `just` handle
* searching for the file if the path is null.
*/
function getJustfileDumpCommand(justfilePath) {
	return justfilePath ? [
		"just",
		"--unstable",
		"--dump",
		"--dump-format",
		"json",
		"--justfile",
		justfilePath
	] : [
		"just",
		"--unstable",
		"--dump",
		"--dump-format",
		"json"
	];
}
/**
* Get a `Fig.Suggestion[]` containing a suggestion for each recipe and alias.
*
* If the optional `showRecipeParameters` prop is `true`, the recipe display
* names will include additional text describing the recipe's parameters, in
* the same style as Fig's autocomplete. (eg. `name <arg>` instead of `name`)
*/
function getRecipeSuggestions(justfile, { showRecipeParameters = false } = {}) {
	const suggestions = [];
	for (const [name, recipe] of Object.entries(justfile.recipes)) {
		if (recipe.private) continue;
		suggestions.push({
			name,
			insertValue: recipe.parameters.length === 0 ? name : name + " ",
			displayName: showRecipeParameters ? getRecipeUsage(recipe) : name,
			description: recipe.doc ?? "Recipe",
			icon: "fig://icon?type=command"
		});
	}
	for (const [name, alias] of Object.entries(justfile.aliases)) suggestions.push({
		name,
		description: `Alias for '${alias.target}'`,
		icon: "fig://icon?type=commandkey"
	});
	return suggestions;
}
/**
* Get a string that is the usage of a recipe, in the same style as Fig's
* options and arguments.
*
* For example, `test <FILTER>`, , `echo [ARGS...]`
*/
function getRecipeUsage(recipe) {
	const parts = [recipe.name];
	for (const parameter of recipe.parameters) if (parameter.kind === "singular") parts.push(`<${parameter.name}>`);
	else if (parameter.kind === "plus") parts.push(`<${parameter.name}...>`);
	else if (parameter.kind === "star") parts.push(`[${parameter.name}...]`);
	else console.error(`Unreachable: unknown kind '${parameter.kind}'`);
	return parts.join(" ");
}
/**
* Get a `Map` of recipe name to its arity, where variadic recipes are set
* to `Infinity`.
*/
function getRecipeArityMap(justfile) {
	const recipeArity = /* @__PURE__ */ new Map();
	let maxArity = 0;
	for (const [name, recipe] of Object.entries(justfile.recipes)) {
		const params = recipe.parameters;
		let arity = params.length;
		if (arity > 0 && params[params.length - 1].kind !== "singular") arity = Infinity;
		if (maxArity < arity) maxArity = arity;
		recipeArity.set(name, arity);
	}
	for (const [name, alias] of Object.entries(justfile.aliases)) {
		const arity = recipeArity.get(alias.target);
		recipeArity.set(name, arity);
	}
	return {
		recipeArity,
		maxArity
	};
}
/**
* Generator script to dump the current justfile as JSON.
*
* If the user has provided -f/--justfile, that file will be used. Otherwise,
* `just` will handle searching for it.
*/
var dumpJustfile = (tokens) => {
	return getJustfileDumpCommand(getJustfilePath(tokens));
};
/**
* Process the output of dumping a justfile as JSON. If JSON parsing
* failed, for any reason, `null` is returned and the error is logged.
*/
function processJustfileDump(out) {
	try {
		return JSON.parse(out);
	} catch (e) {
		console.error(e);
		return null;
	}
}
var completionSpec = {
	name: "just",
	description: "Just a command runner",
	options: [
		{
			name: ["--help", "-h"],
			description: "Print help information"
		},
		{
			name: "--changelog",
			description: "Print the changelog"
		},
		{
			name: "--check",
			description: "Run --fmt in 'check' mode",
			dependsOn: ["--unstable", "--fmt"]
		},
		{
			name: "--choose",
			description: "Select one or more recipes to run using another program"
		},
		{
			name: "--chooser",
			description: "Override the binary invoked by --choose",
			args: { name: "program" }
		},
		{
			name: "--color",
			description: "Print colorful output",
			args: { suggestions: [
				{
					name: "auto",
					icon: "fig://icon?type=string"
				},
				{
					name: "always",
					icon: "fig://icon?type=string"
				},
				{
					name: "never",
					icon: "fig://icon?type=string"
				}
			] }
		},
		{
			name: ["-c", "--command"],
			description: "Run an arbitrary command with the working directory, .env, overrides, and exports",
			args: {
				name: "command",
				isCommand: true
			}
		},
		{
			name: "--completions",
			description: "Print shell completions",
			args: {
				name: "shell",
				suggestions: [
					{
						name: "zsh",
						icon: "fig://icon?type=string"
					},
					{
						name: "bash",
						icon: "fig://icon?type=string"
					},
					{
						name: "fish",
						icon: "fig://icon?type=string"
					},
					{
						name: "powershell",
						icon: "fig://icon?type=string"
					},
					{
						name: "elvish",
						icon: "fig://icon?type=string"
					}
				]
			}
		},
		{
			name: "--clear-shell-args",
			description: "Clear shell arguments"
		},
		{
			name: "--dry-run",
			description: "Print what just would do, without doing it"
		},
		{
			name: "--dump",
			description: "Print justfile"
		},
		{
			name: "--dotenv-filename",
			description: "Use a file with this name instead of .env",
			args: { name: "name" }
		},
		{
			name: "--dotenv-path",
			description: "Load the environment file from a path instead of searching for one"
		},
		{
			name: "--dump-format",
			description: "Specify the format for dumping the justfile",
			dependsOn: ["--dump"],
			args: {
				name: "format",
				suggestions: [{
					name: "just",
					icon: "fig://icon?type=string"
				}, {
					name: "json",
					icon: "fig://icon?type=string",
					description: "This value requires --unstable"
				}]
			}
		},
		{
			name: ["-e", "--edit"],
			description: "Edit the justfile with $VISUAL or $EDITOR, falling back to vim"
		},
		{
			name: "--evaluate",
			description: "Evaluate and print all variables"
		},
		{
			name: "--fmt",
			description: "Format and overwrite the justfile",
			dependsOn: ["--unstable"]
		},
		{
			name: "--highlight",
			description: "Highlight echoed recipe lines in bold",
			exclusiveOn: ["--no-highlight"]
		},
		{
			name: "--init",
			description: "Initialize a new justfile"
		},
		{
			name: ["-f", "--justfile"],
			description: "Use a specific justfile",
			args: {
				name: "file",
				template: "filepaths"
			}
		},
		{
			name: ["-l", "--list"],
			description: "List available recipes and their arguments"
		},
		{
			name: "--list-heading",
			description: "Print this text before the list",
			args: { name: "text" }
		},
		{
			name: "--list-prefix",
			description: "Print this text before each list item",
			args: { name: "text" }
		},
		{
			name: "--no-dotenv",
			description: "Don't load the environment file"
		},
		{
			name: "--no-highlight",
			description: "Don't highlight echoed recipe lines",
			exclusiveOn: ["--highlight"]
		},
		{
			name: ["-q", "--quiet"],
			description: "Suppress all output"
		},
		{
			name: "--set",
			description: "Override a variable with a value",
			args: [{
				name: "variable",
				generators: {
					script: dumpJustfile,
					postProcess: (out) => {
						const justfile = processJustfileDump(out);
						if (justfile === null) return [];
						return Object.keys(justfile.assignments).map((name) => ({
							name,
							icon: "fig://icon?type=string"
						}));
					}
				}
			}, {
				name: "value",
				description: "The string value the variable will be set to"
			}]
		},
		{
			name: "--shell",
			description: "Invoke this shell to run recipes",
			args: {
				name: "shell",
				default: "sh"
			}
		},
		{
			name: "--shell-arg",
			description: "Invoke the shell with this as an argument",
			args: {
				name: "argument",
				default: "-cu"
			}
		},
		{
			name: "--shell-command",
			description: "Invoke --command with the shell used to run recipe lines and backticks"
		},
		{
			name: ["-s", "--show"],
			description: "Show information about a recipe",
			args: {
				name: "recipe",
				generators: {
					script: dumpJustfile,
					postProcess: (out) => {
						const justfile = processJustfileDump(out);
						if (justfile === null) return [];
						return getRecipeSuggestions(justfile);
					}
				}
			}
		},
		{
			name: "--summary",
			description: "List names of available recipes"
		},
		{
			name: ["-u", "--unsorted"],
			description: "Return list and summary entries in source order"
		},
		{
			name: "--unstable",
			description: "Enable unstable features"
		},
		{
			name: "--variables",
			description: "List names of variables"
		},
		{
			name: ["-v", "--verbose"],
			description: "Use verbose output"
		},
		{
			name: ["-V", "--version"],
			description: "Print version information"
		},
		{
			name: ["-d", "--working-directory"],
			description: "Use this as the working directory",
			dependsOn: ["--justfile"],
			args: { template: "folders" }
		}
	],
	args: {
		name: "args",
		isVariadic: true,
		isOptional: true,
		optionsCanBreakVariadicArg: false,
		generators: {
			trigger: (newToken, oldToken) => {
				return newToken.length === 0 && oldToken.length > 0;
			},
			script: dumpJustfile,
			postProcess: (out, tokens) => {
				const justfile = processJustfileDump(out);
				if (justfile === null) return [];
				const { recipeArity, maxArity } = getRecipeArityMap(justfile);
				const indicesToCheck = Math.min(maxArity, tokens.length - 2);
				for (let checked = 0; checked < indicesToCheck; checked++) {
					const token = tokens[tokens.length - 2 - checked];
					const arity = recipeArity.get(token);
					if (arity === void 0) continue;
					if (arity > checked) return [];
					else break;
				}
				return getRecipeSuggestions(justfile, { showRecipeParameters: true });
			}
		}
	}
};
//#endregion
export { completionSpec as default };
