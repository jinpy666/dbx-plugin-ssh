//#region \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
//#endregion
//#region vendor/fig-npm/autocomplete-generators/lib/src/resolve.js
var require_resolve = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.shellExpand = exports.ensureTrailingSlash = void 0;
	var ensureTrailingSlash = (str) => str.endsWith("/") ? str : `${str}/`;
	exports.ensureTrailingSlash = ensureTrailingSlash;
	var replaceTilde = (path, homeDir) => {
		if (path.startsWith("~") && (path.length === 1 || path.charAt(1) === "/")) return path.replace("~", homeDir);
		return path;
	};
	var replaceVariables = (path, environmentVariables) => {
		return path.replace(/\$([A-Za-z0-9_]+)/g, (key) => {
			var _a;
			return (_a = environmentVariables[key.slice(1)]) !== null && _a !== void 0 ? _a : key;
		}).replace(/\$\{([A-Za-z0-9_]+)(?::-([^}]+))?\}/g, (match, envKey, defaultValue) => {
			var _a, _b;
			return (_b = (_a = environmentVariables[envKey]) !== null && _a !== void 0 ? _a : defaultValue) !== null && _b !== void 0 ? _b : match;
		});
	};
	var shellExpand = (path, context) => {
		var _a;
		const { environmentVariables } = context;
		return replaceVariables(replaceTilde(path, (_a = environmentVariables === null || environmentVariables === void 0 ? void 0 : environmentVariables.HOME) !== null && _a !== void 0 ? _a : "~"), environmentVariables);
	};
	exports.shellExpand = shellExpand;
}));
//#endregion
//#region vendor/fig-npm/autocomplete-generators/lib/src/filepaths.js
var require_filepaths = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
		function adopt(value) {
			return value instanceof P ? value : new P(function(resolve) {
				resolve(value);
			});
		}
		return new (P || (P = Promise))(function(resolve, reject) {
			function fulfilled(value) {
				try {
					step(generator.next(value));
				} catch (e) {
					reject(e);
				}
			}
			function rejected(value) {
				try {
					step(generator["throw"](value));
				} catch (e) {
					reject(e);
				}
			}
			function step(result) {
				result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
			}
			step((generator = generator.apply(thisArg, _arguments || [])).next());
		});
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.filepaths = exports.folders = exports.getCurrentInsertedDirectory = exports.sortFilesAlphabetically = void 0;
	var resolve_1 = require_resolve();
	function sortFilesAlphabetically(array, skip = []) {
		const skipLower = skip.map((str) => str.toLowerCase());
		const results = array.filter((x) => !skipLower.includes(x.toLowerCase()));
		return [
			...results.filter((x) => !x.startsWith(".")).sort((a, b) => a.localeCompare(b)),
			...results.filter((x) => x.startsWith(".")).sort((a, b) => a.localeCompare(b)),
			"../"
		];
	}
	exports.sortFilesAlphabetically = sortFilesAlphabetically;
	/**
	* @param cwd - The current working directory when the user started typing the new path
	* @param searchTerm - The path inserted by the user, it can be relative to cwd or absolute
	* @returns The directory the user inserted, taking into account the cwd.
	*/
	var getCurrentInsertedDirectory = (cwd, searchTerm, context) => {
		if (cwd === null) return "/";
		const resolvedPath = (0, resolve_1.shellExpand)(searchTerm, context);
		const dirname = resolvedPath.slice(0, resolvedPath.lastIndexOf("/") + 1);
		if (dirname === "") return (0, resolve_1.ensureTrailingSlash)(cwd);
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
		const { extensions = [], equals = [], matches, filterFolders = false, editFileSuggestions, editFolderSuggestions, rootDirectory, showFolders = "always" } = options;
		const extensionsSet = new Set(extensions);
		const equalsSet = new Set(equals);
		const shouldFilterSuggestions = () => extensions.length > 0 || equals.length > 0 || matches;
		const filterSuggestions = (suggestions = []) => {
			if (!shouldFilterSuggestions()) return suggestions;
			return suggestions.filter(({ name = "", type }) => {
				if (!filterFolders && type === "folder") return true;
				if (equalsSet.has(name)) return true;
				if (matches && !!name.match(matches)) return true;
				const [, ...suggestionExtensions] = name.split(".");
				if (suggestionExtensions.length >= 1) {
					let i = suggestionExtensions.length - 1;
					let stackedExtensions = suggestionExtensions[i];
					do {
						if (extensionsSet.has(stackedExtensions)) return true;
						i -= 1;
						stackedExtensions = [suggestionExtensions[i], stackedExtensions].join(".");
					} while (i >= 0);
				}
				return false;
			});
		};
		const postProcessSuggestions = (suggestions = []) => {
			if (!editFileSuggestions && !editFolderSuggestions) return suggestions;
			return suggestions.map((suggestion) => Object.assign(Object.assign({}, suggestion), (suggestion.type === "file" ? editFileSuggestions : editFolderSuggestions) || {}));
		};
		return {
			trigger: (oldToken, newToken) => {
				const oldLastSlashIndex = oldToken.lastIndexOf("/");
				const newLastSlashIndex = newToken.lastIndexOf("/");
				if (oldLastSlashIndex !== newLastSlashIndex) return true;
				if (oldLastSlashIndex === -1 && newLastSlashIndex === -1) return false;
				return oldToken.slice(0, oldLastSlashIndex) !== newToken.slice(0, newLastSlashIndex);
			},
			getQueryTerm: (token) => token.slice(token.lastIndexOf("/") + 1),
			custom: (_, executeCommand, generatorContext) => __awaiter(this, void 0, void 0, function* () {
				var _a;
				const { isDangerous, currentWorkingDirectory, searchTerm } = generatorContext;
				const currentInsertedDirectory = (_a = (0, exports.getCurrentInsertedDirectory)(rootDirectory !== null && rootDirectory !== void 0 ? rootDirectory : currentWorkingDirectory, searchTerm, generatorContext)) !== null && _a !== void 0 ? _a : "/";
				try {
					const sortedFiles = sortFilesAlphabetically((yield executeCommand({
						command: "ls",
						args: ["-1ApL"],
						cwd: currentInsertedDirectory
					})).stdout.split("\n"), [".DS_Store"]);
					const generatorOutputArray = [];
					for (const name of sortedFiles) if (name) {
						const templateType = name.endsWith("/") ? "folders" : "filepaths";
						if (templateType === "filepaths" && showFolders !== "only" || templateType === "folders" && showFolders !== "never") generatorOutputArray.push({
							type: templateType === "filepaths" ? "file" : "folder",
							name,
							insertValue: name,
							isDangerous,
							context: { templateType }
						});
					}
					return postProcessSuggestions(filterSuggestions(generatorOutputArray));
				} catch (err) {
					return [];
				}
			})
		};
	}
	exports.folders = Object.assign(() => filepathsFn({ showFolders: "only" }), Object.freeze(filepathsFn({ showFolders: "only" })));
	exports.filepaths = Object.assign(filepathsFn, Object.freeze(filepathsFn()));
}));
//#endregion
//#region vendor/fig-npm/autocomplete-generators/lib/src/keyvalue.js
var require_keyvalue = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
		function adopt(value) {
			return value instanceof P ? value : new P(function(resolve) {
				resolve(value);
			});
		}
		return new (P || (P = Promise))(function(resolve, reject) {
			function fulfilled(value) {
				try {
					step(generator.next(value));
				} catch (e) {
					reject(e);
				}
			}
			function rejected(value) {
				try {
					step(generator["throw"](value));
				} catch (e) {
					reject(e);
				}
			}
			function step(result) {
				result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
			}
			step((generator = generator.apply(thisArg, _arguments || [])).next());
		});
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.keyValueList = exports.keyValue = exports.valueList = void 0;
	/** Cache of Fig suggestions using the string[]/Suggestion[]/function as a key */
	var suggestionCache = /* @__PURE__ */ new Map();
	function appendToInsertValue(append, suggestions) {
		if (append.length === 0) return suggestions;
		return suggestions.map((item) => item.insertValue ? item : Object.assign(Object.assign({}, item), { insertValue: item.name + append }));
	}
	function kvSuggestionsToFigSuggestions(suggestions, append, init) {
		return __awaiter(this, void 0, void 0, function* () {
			if (typeof suggestions === "function") return appendToInsertValue(append, yield suggestions(...init));
			if (typeof suggestions[0] === "string") return appendToInsertValue(append, suggestions.map((name) => ({ name })));
			return appendToInsertValue(append, suggestions);
		});
	}
	function getSuggestions(suggestions, append, useSuggestionCache, init) {
		return __awaiter(this, void 0, void 0, function* () {
			if (useSuggestionCache || Array.isArray(suggestions)) {
				let value = suggestionCache.get(suggestions);
				if (value === void 0) {
					value = yield kvSuggestionsToFigSuggestions(suggestions, append, init);
					suggestionCache.set(suggestions, value);
				}
				return value;
			}
			return kvSuggestionsToFigSuggestions(suggestions, append, init);
		});
	}
	function shouldUseCache(isKey, cache) {
		if (typeof cache === "string") return isKey && cache === "keys" || !isKey && cache === "values";
		return cache;
	}
	/** Get the final index of any of the strings */
	function lastIndexOf(haystack, ...needles) {
		return Math.max(...needles.map((needle) => haystack.lastIndexOf(needle)));
	}
	function removeRepeatSuggestions(alreadyUsed, suggestions) {
		const seen = new Set(alreadyUsed);
		return suggestions.filter((suggestion) => {
			var _a;
			if (typeof suggestion.name === "string") return !seen.has(suggestion.name);
			return !((_a = suggestion.name) === null || _a === void 0 ? void 0 : _a.some((name) => seen.has(name)));
		});
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
	function valueList({ delimiter = ",", values = [], cache = false, insertDelimiter = false, allowRepeatedValues = false }) {
		return {
			trigger: (newToken, oldToken) => newToken.lastIndexOf(delimiter) !== oldToken.lastIndexOf(delimiter),
			getQueryTerm: (token) => token.slice(token.lastIndexOf(delimiter) + delimiter.length),
			custom: (...init) => __awaiter(this, void 0, void 0, function* () {
				var _a;
				const out = yield getSuggestions(values, insertDelimiter ? delimiter : "", cache, init);
				if (allowRepeatedValues) return out;
				const [tokens] = init;
				return removeRepeatSuggestions((_a = tokens[tokens.length - 1]) === null || _a === void 0 ? void 0 : _a.split(delimiter), out);
			})
		};
	}
	exports.valueList = valueList;
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
	function keyValue({ separator = "=", keys = [], values = [], cache = false, insertSeparator = true }) {
		return {
			trigger: (newToken, oldToken) => newToken.indexOf(separator) !== oldToken.indexOf(separator),
			getQueryTerm: (token) => token.slice(token.indexOf(separator) + 1),
			custom: (...init) => __awaiter(this, void 0, void 0, function* () {
				const [tokens] = init;
				const isKey = !tokens[tokens.length - 1].includes(separator);
				const suggestions = isKey ? keys : values;
				const useCache = shouldUseCache(isKey, cache);
				return getSuggestions(suggestions, isKey ? insertSeparator ? separator : "" : "", useCache, init);
			})
		};
	}
	exports.keyValue = keyValue;
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
	function keyValueList({ separator = "=", delimiter = ",", keys = [], values = [], cache = false, insertSeparator = true, insertDelimiter = false, allowRepeatedKeys = false, allowRepeatedValues = true }) {
		return {
			trigger: (newToken, oldToken) => {
				return lastIndexOf(newToken, separator, delimiter) !== lastIndexOf(oldToken, separator, delimiter);
			},
			getQueryTerm: (token) => {
				const index = lastIndexOf(token, separator, delimiter);
				return token.slice(index + 1);
			},
			custom: (...init) => __awaiter(this, void 0, void 0, function* () {
				const [tokens] = init;
				const finalToken = tokens[tokens.length - 1];
				const index = lastIndexOf(finalToken, separator, delimiter);
				const isKey = index === -1 || finalToken.slice(index, index + separator.length) !== separator;
				const suggestions = isKey ? keys : values;
				const useCache = shouldUseCache(isKey, cache);
				const out = yield getSuggestions(suggestions, isKey ? insertSeparator ? separator : "" : insertDelimiter ? delimiter : "", useCache, init);
				if (isKey) {
					if (allowRepeatedKeys) return out;
					return removeRepeatSuggestions(finalToken.split(delimiter).map((chunk) => chunk.slice(0, chunk.indexOf(separator))), out);
				}
				if (allowRepeatedValues) return out;
				return removeRepeatSuggestions(finalToken.split(delimiter).map((chunk) => chunk.slice(chunk.indexOf(separator) + separator.length)), out);
			})
		};
	}
	exports.keyValueList = keyValueList;
}));
//#endregion
//#region vendor/fig-npm/autocomplete-generators/lib/src/ai.js
var require_ai = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
		function adopt(value) {
			return value instanceof P ? value : new P(function(resolve) {
				resolve(value);
			});
		}
		return new (P || (P = Promise))(function(resolve, reject) {
			function fulfilled(value) {
				try {
					step(generator.next(value));
				} catch (e) {
					reject(e);
				}
			}
			function rejected(value) {
				try {
					step(generator["throw"](value));
				} catch (e) {
					reject(e);
				}
			}
			function step(result) {
				result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
			}
			step((generator = generator.apply(thisArg, _arguments || [])).next());
		});
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ai = void 0;
	var MAX_CHARS = 16388 * .8;
	/**
	* A generator that uses the Fig AI API to generate suggestions.
	*
	* @param prompt The prompt to use for the AI. Can be a string or a generator function.
	* @param message The message to send to the AI. Can be a string or a generator function.
	* @param postProcess A function to post-process the AI's response.
	* @param temperature The temperature to use for the AI.
	* @returns A Fig generator.
	*/
	function ai({ name, prompt, message, postProcess, temperature, splitOn }) {
		return {
			scriptTimeout: 15e3,
			custom: (tokens, executeCommand, generatorContext) => __awaiter(this, void 0, void 0, function* () {
				var _a, _b;
				const settingOutput = yield executeCommand({
					command: "fig",
					args: [
						"settings",
						"--format",
						"json",
						"autocomplete.ai.enabled"
					]
				});
				if (!JSON.parse(settingOutput.stdout)) return [];
				const promptString = typeof prompt === "function" ? yield prompt({
					tokens,
					executeCommand,
					generatorContext
				}) : prompt;
				const messageString = typeof message === "function" ? yield message({
					tokens,
					executeCommand,
					generatorContext
				}) : message;
				if (messageString === null || messageString.length === 0) {
					console.warn("No message provided to AI generator");
					return [];
				}
				const budget = MAX_CHARS - ((_a = promptString === null || promptString === void 0 ? void 0 : promptString.length) !== null && _a !== void 0 ? _a : 0);
				const body = {
					model: "gpt-3.5-turbo",
					source: "autocomplete",
					name,
					messages: [...promptString ? [{
						role: "system",
						content: promptString
					}] : [], {
						role: "user",
						content: messageString.slice(0, budget)
					}],
					temperature
				};
				const requestOutput = yield executeCommand({
					command: "fig",
					args: [
						"_",
						"request",
						"--route",
						"/ai/chat",
						"--method",
						"POST",
						"--body",
						JSON.stringify(body)
					]
				});
				const json = JSON.parse(requestOutput.stdout);
				return (_b = json === null || json === void 0 ? void 0 : json.choices.map((c) => {
					var _a;
					return (_a = c === null || c === void 0 ? void 0 : c.message) === null || _a === void 0 ? void 0 : _a.content;
				}).filter((c) => typeof c === "string").flatMap((c) => splitOn ? c.split(splitOn).filter((s) => s.trim().length > 0) : [c]).map((out) => {
					if (postProcess) return postProcess(out);
					const text = out.trim().replace(/\n/g, " ");
					return {
						icon: "🪄",
						name: text,
						insertValue: `'${text}'`,
						description: "Generated by Fig AI"
					};
				})) !== null && _b !== void 0 ? _b : [];
			})
		};
	}
	exports.ai = ai;
}));
var completionSpec = {
	name: "python",
	description: "Run the python interpreter",
	generateSpec: async (tokens, executeShellCommand) => {
		if ((await executeShellCommand({
			command: "bash",
			args: ["-c", "cat manage.py | grep -q django"]
		})).status === 0) return {
			name: "python",
			subcommands: [{
				name: "manage.py",
				loadSpec: "django-admin"
			}]
		};
	},
	args: {
		name: "python script",
		isScript: true,
		generators: (0, (/* @__PURE__ */ __commonJSMin(((exports) => {
			var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
				if (k2 === void 0) k2 = k;
				var desc = Object.getOwnPropertyDescriptor(m, k);
				if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
					enumerable: true,
					get: function() {
						return m[k];
					}
				};
				Object.defineProperty(o, k2, desc);
			}) : (function(o, m, k, k2) {
				if (k2 === void 0) k2 = k;
				o[k2] = m[k];
			}));
			var __exportStar = exports && exports.__exportStar || function(m, exports$1) {
				for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$1, p)) __createBinding(exports$1, m, p);
			};
			Object.defineProperty(exports, "__esModule", { value: true });
			exports.ai = exports.folders = exports.filepaths = void 0;
			var filepaths_1 = require_filepaths();
			Object.defineProperty(exports, "filepaths", {
				enumerable: true,
				get: function() {
					return filepaths_1.filepaths;
				}
			});
			Object.defineProperty(exports, "folders", {
				enumerable: true,
				get: function() {
					return filepaths_1.folders;
				}
			});
			__exportStar(require_keyvalue(), exports);
			var ai_1 = require_ai();
			Object.defineProperty(exports, "ai", {
				enumerable: true,
				get: function() {
					return ai_1.ai;
				}
			});
		})))().filepaths)({
			extensions: ["py"],
			editFileSuggestions: { priority: 76 }
		})
	},
	options: [
		{
			name: "-c",
			insertValue: "-c '{cursor}'",
			description: "Execute the Python code in command. command can be one or more statements separated by newlines, with significant leading whitespace as in normal module code",
			args: {
				name: "command",
				isCommand: true
			}
		},
		{
			name: "-m",
			description: "Module",
			args: {
				name: "python module",
				isModule: "python/",
				suggestions: ["http.server"]
			}
		},
		{
			name: [
				"-?",
				"-h",
				"--help"
			],
			description: "Print a short description of all command line options"
		},
		{
			name: ["-V", "--version"],
			description: "Print the Python version number and exit"
		},
		{
			name: "-b",
			description: "Issue a warning when comparing bytes or bytearray with str or bytes with int. Issue an error when the option is given twice (-bb)"
		},
		{
			name: "-B",
			description: "If given, Python won’t try to write .pyc files on the import of source modules"
		},
		{
			name: "--check-hash-based-pycs",
			description: "Control the validation behavior of hash-based .pyc files. See Cached bytecode invalidation",
			args: { suggestions: [
				{ name: "default" },
				{ name: "always" },
				{ name: "never" }
			] }
		},
		{
			name: "-d",
			description: "Turn on parser debugging output (for expert only, depending on compilation options)"
		},
		{
			name: "-E",
			description: "Ignore all PYTHON* environment variables, e.g. PYTHONPATH and PYTHONHOME, that might be set"
		},
		{
			name: "-i",
			description: "When a script is passed as first argument or the -c option is used, enter interactive mode after executing the script or the command, even when sys.stdin does not appear to be a terminal"
		},
		{
			name: "-I",
			description: "Run Python in isolated mode. This also implies -E and -s. In isolated mode sys.path contains neither the script’s directory nor the user’s site-packages directory"
		},
		{
			name: "-O",
			description: "Remove assert statements and any code conditional on the value of __debug__"
		},
		{
			name: "-OO",
			description: "Do -O and also discard docstrings"
		},
		{
			name: "-g",
			description: "Don’t display the copyright and version messages even in interactive mode"
		},
		{
			name: "-R",
			description: "Turn on hash randomization. This option only has an effect if the PYTHONHASHSEED environment variable is set to 0, since hash randomization is enabled by default"
		},
		{
			name: "-s",
			description: "Don’t add the user site-packages directory to sys.path"
		},
		{
			name: "-S",
			description: "Disable the import of the module site and the site-dependent manipulations of sys.path that it entails"
		},
		{
			name: "-u",
			description: "Force the stdout and stderr streams to be unbuffered. This option has no effect on the stdin stream"
		},
		{
			name: "-v",
			description: "Print a message each time a module is initialized, showing the place (filename or built-in module) from which it is loaded"
		},
		{
			name: "-W",
			description: "Warning control. Python’s warning machinery by default prints warning messages to sys.stderr",
			args: {}
		},
		{
			name: "-x",
			description: "Skip the first line of the source, allowing use of non-Unix forms of #!cmd. This is intended for a DOS specific hack only"
		},
		{
			name: "-X",
			description: "Reserved for various implementation-specific options",
			args: { suggestions: [
				{ name: "faulthandler" },
				{ name: "showrefcount" },
				{ name: "tracemalloc" },
				{ name: "showalloccount" },
				{ name: "importtime" },
				{ name: "dev" },
				{ name: "utf8" },
				{ name: "pycache_prefix=PATH" }
			] }
		}
	]
};
//#endregion
export { completionSpec as default };
