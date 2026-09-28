//#region \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
//#endregion
//#region vendor/fig-npm/autocomplete-shared/dist/esm/src/utils.js
function makeArray$1(object) {
	return Array.isArray(object) ? object : [object];
}
var SpecLocationSource;
(function(SpecLocationSource) {
	SpecLocationSource["GLOBAL"] = "global";
	SpecLocationSource["LOCAL"] = "local";
})(SpecLocationSource || (SpecLocationSource = {}));
//#endregion
//#region vendor/fig-npm/autocomplete-shared/dist/esm/src/convert.js
var makeNamedMap = (items) => {
	const nameMapping = {};
	if (!items) return nameMapping;
	for (let i = 0; i < items.length; i += 1) items[i].name.forEach((name) => {
		nameMapping[name] = items[i];
	});
	return nameMapping;
};
function convertOption(option, initialize) {
	return Object.assign(Object.assign({}, initialize.option(option)), {
		name: makeArray$1(option.name),
		args: option.args ? makeArray$1(option.args).map(initialize.arg) : []
	});
}
function convertSubcommand(subcommand, initialize) {
	var _a, _b;
	const { subcommands, options, args } = subcommand;
	return Object.assign(Object.assign({}, initialize.subcommand(subcommand)), {
		name: makeArray$1(subcommand.name),
		subcommands: makeNamedMap(subcommands === null || subcommands === void 0 ? void 0 : subcommands.map((s) => convertSubcommand(s, initialize))),
		options: makeNamedMap((_a = options === null || options === void 0 ? void 0 : options.filter((option) => !option.isPersistent)) === null || _a === void 0 ? void 0 : _a.map((option) => convertOption(option, initialize))),
		persistentOptions: makeNamedMap((_b = options === null || options === void 0 ? void 0 : options.filter((option) => option.isPersistent)) === null || _b === void 0 ? void 0 : _b.map((option) => convertOption(option, initialize))),
		args: args ? makeArray$1(args).map(initialize.arg) : []
	});
}
//#endregion
//#region vendor/fig-npm/autocomplete-shared/dist/esm/src/specMetadata.js
var __rest = function(s, e) {
	var t = {};
	for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0) t[p] = s[p];
	if (s != null && typeof Object.getOwnPropertySymbols === "function") {
		for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i])) t[p[i]] = s[p[i]];
	}
	return t;
};
function convertLoadSpec(loadSpec, initialize) {
	if (typeof loadSpec === "string") return [{
		name: loadSpec,
		type: SpecLocationSource.GLOBAL
	}];
	if (typeof loadSpec === "function") return (...args) => loadSpec(...args).then((result) => {
		if (Array.isArray(result)) return result;
		if ("type" in result) return [result];
		return convertSubcommand(result, initialize);
	});
	return convertSubcommand(loadSpec, initialize);
}
function initializeOptionMeta(option) {
	return option;
}
function initializeArgMeta(arg) {
	var _a;
	const { template } = arg, rest = __rest(arg, ["template"]);
	const generators = template ? [{ template }] : makeArray$1((_a = arg.generators) !== null && _a !== void 0 ? _a : []);
	return Object.assign(Object.assign({}, rest), {
		loadSpec: arg.loadSpec ? convertLoadSpec(arg.loadSpec, {
			option: initializeOptionMeta,
			subcommand: initializeSubcommandMeta,
			arg: initializeArgMeta
		}) : void 0,
		generators: generators.map((generator) => {
			let { trigger, getQueryTerm } = generator;
			if (generator.template) {
				const templates = makeArray$1(generator.template);
				if (templates.includes("folders") || templates.includes("filepaths")) {
					trigger = trigger !== null && trigger !== void 0 ? trigger : "/";
					getQueryTerm = getQueryTerm !== null && getQueryTerm !== void 0 ? getQueryTerm : "/";
				}
			}
			return Object.assign(Object.assign({}, generator), {
				trigger,
				getQueryTerm
			});
		})
	});
}
function initializeSubcommandMeta(subcommand) {
	return Object.assign(Object.assign({}, subcommand), { loadSpec: subcommand.loadSpec ? convertLoadSpec(subcommand.loadSpec, {
		subcommand: initializeSubcommandMeta,
		option: initializeOptionMeta,
		arg: initializeArgMeta
	}) : void 0 });
}
var initializeDefault = {
	subcommand: initializeSubcommandMeta,
	option: initializeOptionMeta,
	arg: initializeArgMeta
};
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
//#endregion
//#region vendor/amazon-q-autocomplete/packages/shared/src/errors.ts
var import_lib = (/* @__PURE__ */ __commonJSMin(((exports) => {
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
})))();
var createErrorInstance = (name) => class extends Error {
	constructor(message) {
		super(message);
		this.name = `AmazonQ.${name}`;
	}
};
//#endregion
//#region vendor/amazon-q-autocomplete/packages/shared/src/utils.ts
var SuggestionFlag = /* @__PURE__ */ function(SuggestionFlag) {
	SuggestionFlag[SuggestionFlag["None"] = 0] = "None";
	SuggestionFlag[SuggestionFlag["Subcommands"] = 1] = "Subcommands";
	SuggestionFlag[SuggestionFlag["Options"] = 2] = "Options";
	SuggestionFlag[SuggestionFlag["Args"] = 4] = "Args";
	SuggestionFlag[SuggestionFlag["Any"] = 7] = "Any";
	return SuggestionFlag;
}({});
function makeArray(object) {
	return Array.isArray(object) ? object : [object];
}
function firstMatchingToken(str, chars) {
	for (const char of str) if (chars.has(char)) return char;
}
//#endregion
//#region vendor/amazon-q-autocomplete/packages/shell-parser/src/parser.ts
var NodeType = /* @__PURE__ */ function(NodeType) {
	NodeType["Program"] = "program";
	NodeType["AssignmentList"] = "assignment_list";
	NodeType["Assignment"] = "assignment";
	NodeType["VariableName"] = "variable_name";
	NodeType["Subscript"] = "subscript";
	NodeType["CompoundStatement"] = "compound_statement";
	NodeType["Subshell"] = "subshell";
	NodeType["Command"] = "command";
	NodeType["Pipeline"] = "pipeline";
	NodeType["List"] = "list";
	NodeType["ProcessSubstitution"] = "process_substitution";
	NodeType["Concatenation"] = "concatenation";
	NodeType["Word"] = "word";
	NodeType["String"] = "string";
	NodeType["Expansion"] = "expansion";
	NodeType["CommandSubstitution"] = "command_substitution";
	NodeType["RawString"] = "raw_string";
	NodeType["AnsiCString"] = "ansi_c_string";
	NodeType["SimpleExpansion"] = "simple_expansion";
	NodeType["SpecialExpansion"] = "special_expansion";
	NodeType["ArithmeticExpansion"] = "arithmetic_expansion";
	return NodeType;
}({});
var operators = [
	";",
	"&",
	"&;",
	"|",
	"|&",
	"&&",
	"||"
];
var parseOperator = (str, index) => {
	const c = str.charAt(index);
	if ([
		"&",
		";",
		"|"
	].includes(c)) {
		const op = str.slice(index, index + 2);
		return operators.includes(op) ? op : c;
	}
	return null;
};
var getInnerText = (node) => {
	const { children, type, complete, text } = node;
	if (type === NodeType.Concatenation) return children.reduce((current, child) => current + child.innerText, "");
	const terminalChars = {
		[NodeType.String]: ["\"", "\""],
		[NodeType.RawString]: ["'", "'"],
		[NodeType.AnsiCString]: ["$'", "'"]
	}[type] || ["", ""];
	const startChars = terminalChars[0];
	const endChars = !complete ? "" : terminalChars[1];
	let innerText = "";
	for (let i = startChars.length; i < text.length - endChars.length; i += 1) {
		const c = text.charAt(i);
		const isWordEscape = c === "\\" && type === NodeType.Word;
		const isStringEscape = c === "\\" && type === NodeType.String && "$`\"\\\n".includes(text.charAt(i + 1));
		if (isWordEscape || isStringEscape) i += 1;
		innerText += text.charAt(i);
	}
	return innerText;
};
var createNode = (str, partial) => {
	const node = {
		startIndex: 0,
		type: NodeType.Word,
		endIndex: str.length,
		text: "",
		innerText: "",
		complete: true,
		children: [],
		...partial
	};
	const text = str.slice(node.startIndex, node.endIndex);
	const innerText = getInnerText({
		...node,
		text
	});
	return {
		...node,
		text,
		innerText
	};
};
var createTextNode = (str, startIndex, text) => createNode(str, {
	startIndex,
	text,
	endIndex: startIndex + text.length
});
var nextWordIndex = (str, index) => {
	const firstChar = str.slice(index).search(/\S/);
	if (firstChar === -1) return -1;
	return index + firstChar;
};
var parseSimpleExpansion = (str, index, terminalChars) => {
	const node = {
		startIndex: index,
		type: NodeType.SimpleExpansion
	};
	if (str.length > index + 1 && "*@?-$0_".includes(str.charAt(index + 1))) return createNode(str, {
		...node,
		type: NodeType.SpecialExpansion,
		endIndex: index + 2
	});
	const terminalSymbols = [
		"	",
		" ",
		"\n",
		"$",
		"\\",
		...terminalChars
	];
	let i = index + 1;
	for (; i < str.length; i += 1) if (terminalSymbols.includes(str.charAt(i))) return i === index + 1 ? null : createNode(str, {
		...node,
		endIndex: i
	});
	return createNode(str, {
		...node,
		endIndex: i
	});
};
function parseCommandSubstitution(str, startIndex, terminalChar) {
	const { statements: children, terminatorIndex } = parseStatements(str, str.charAt(startIndex) === "`" ? startIndex + 1 : startIndex + 2, terminalChar);
	const terminated = terminatorIndex !== -1;
	return createNode(str, {
		startIndex,
		type: NodeType.CommandSubstitution,
		complete: terminated && children.length !== 0,
		endIndex: terminated ? terminatorIndex + 1 : str.length,
		children
	});
}
var parseString = parseLiteral(NodeType.String, "\"", "\"");
var parseRawString = parseLiteral(NodeType.RawString, "'", "'");
var parseExpansion = parseLiteral(NodeType.Expansion, "${", "}");
var parseAnsiCString = parseLiteral(NodeType.AnsiCString, "$'", "'");
var parseArithmeticExpansion = parseLiteral(NodeType.ArithmeticExpansion, "$((", "))");
function childAtIndex(str, index, inString, terminators) {
	const lookahead = [
		str.charAt(index),
		str.charAt(index + 1),
		str.charAt(index + 2)
	];
	switch (lookahead[0]) {
		case "$":
			if (lookahead[1] === "(") return lookahead[2] === "(" ? parseArithmeticExpansion(str, index) : parseCommandSubstitution(str, index, ")");
			if (lookahead[1] === "{") return parseExpansion(str, index);
			if (!inString && lookahead[1] === "'") return parseAnsiCString(str, index);
			return parseSimpleExpansion(str, index, terminators);
		case "`": return parseCommandSubstitution(str, index, "`");
		case "'": return inString ? null : parseRawString(str, index);
		case "\"": return inString ? null : parseString(str, index);
		default: return null;
	}
}
function parseLiteral(type, startChars, endChars) {
	const canHaveChildren = type === NodeType.Expansion || type === NodeType.String;
	const isString = type === NodeType.String;
	return (str, startIndex) => {
		const children = [];
		for (let i = startIndex + startChars.length; i < str.length; i += 1) {
			const child = canHaveChildren ? childAtIndex(str, i, isString, [endChars]) : null;
			if (child !== null) {
				children.push(child);
				i = child.endIndex - 1;
			} else if (str.charAt(i) === "\\" && type !== NodeType.RawString) i += 1;
			else if (str.slice(i, i + endChars.length) === endChars) return createNode(str, {
				startIndex,
				type,
				children,
				endIndex: i + endChars.length
			});
		}
		return createNode(str, {
			startIndex,
			type,
			children,
			complete: false
		});
	};
}
function parseStatements(str, index, terminalChar, mustTerminate = false) {
	const statements = [];
	let i = index;
	while (i < str.length) {
		let statement = parseStatement(str, i, mustTerminate ? "" : terminalChar);
		const opIndex = nextWordIndex(str, statement.endIndex);
		const reachedEnd = opIndex === -1;
		if (!mustTerminate && !reachedEnd && terminalChar === str.charAt(opIndex)) {
			statements.push(statement);
			return {
				statements,
				terminatorIndex: opIndex
			};
		}
		if (reachedEnd) {
			statements.push(statement);
			break;
		}
		const op = !reachedEnd && parseOperator(str, opIndex);
		if (op) {
			i = opIndex + op.length;
			const nextIndex = nextWordIndex(str, i);
			statements.push(statement);
			if (nextIndex !== -1 && str.charAt(nextIndex) === terminalChar) return {
				statements,
				terminatorIndex: nextIndex
			};
		} else {
			statement = createNode(str, {
				...statement,
				complete: statement.type === NodeType.AssignmentList ? statement.complete : false
			});
			statements.push(statement);
			i = opIndex;
		}
	}
	return {
		statements,
		terminatorIndex: -1
	};
}
var parseConcatenationOrLiteralNode = (str, startIndex, terminalChar) => {
	const children = [];
	let argumentChildren = [];
	let wordStart = -1;
	const endWord = (endIndex) => {
		if (wordStart !== -1) {
			const word = createNode(str, {
				startIndex: wordStart,
				endIndex
			});
			argumentChildren.push(word);
		}
		wordStart = -1;
	};
	const endArgument = (endIndex) => {
		endWord(endIndex);
		let [argument] = argumentChildren;
		if (argumentChildren.length > 1) {
			const finalPart = argumentChildren[argumentChildren.length - 1];
			argument = createNode(str, {
				startIndex: argumentChildren[0].startIndex,
				type: NodeType.Concatenation,
				endIndex: finalPart.endIndex,
				complete: finalPart.complete,
				children: argumentChildren
			});
		}
		if (argument) children.push(argument);
		argumentChildren = [];
	};
	const terminators = [
		"&",
		"|",
		";",
		"\n",
		"'",
		"\"",
		"`"
	];
	if (terminalChar) terminators.push(terminalChar);
	let i = startIndex;
	for (; i < str.length; i += 1) {
		const c = str.charAt(i);
		if (parseOperator(str, i) !== null || c === terminalChar) break;
		const childNode = childAtIndex(str, i, false, terminators);
		if (childNode !== null) {
			endWord(i);
			argumentChildren.push(childNode);
			i = childNode.endIndex - 1;
		} else if ([" ", "	"].includes(c)) endArgument(i);
		else {
			if (c === "\\") i += 1;
			if (wordStart === -1) wordStart = i;
		}
	}
	endArgument(i);
	return {
		children,
		endIndex: i
	};
};
function parseCommand(str, idx, terminalChar) {
	const startIndex = Math.max(nextWordIndex(str, idx), idx);
	const { children, endIndex } = parseConcatenationOrLiteralNode(str, startIndex, terminalChar);
	return createNode(str, {
		startIndex,
		type: NodeType.Command,
		complete: children.length > 0,
		endIndex: children.length > 0 ? endIndex : str.length,
		children
	});
}
var parseAssignmentNode = (str, startIndex) => {
	const equalsIndex = str.indexOf("=", startIndex);
	const operator = str.charAt(equalsIndex - 1) === "+" ? "+=" : "=";
	const firstOperatorCharIndex = operator === "=" ? equalsIndex : equalsIndex - 1;
	const firstSquareBracketIndex = str.slice(startIndex, firstOperatorCharIndex).indexOf("[");
	let nameNode;
	const variableName = createNode(str, {
		type: NodeType.VariableName,
		startIndex,
		endIndex: firstSquareBracketIndex !== -1 ? firstSquareBracketIndex : firstOperatorCharIndex
	});
	if (firstSquareBracketIndex !== -1) {
		const index = createNode(str, {
			type: NodeType.Word,
			startIndex: firstSquareBracketIndex + 1,
			endIndex: firstOperatorCharIndex - 1
		});
		nameNode = createNode(str, {
			type: NodeType.Subscript,
			name: variableName,
			startIndex,
			endIndex: index.endIndex + 1,
			children: [index]
		});
	} else nameNode = variableName;
	const { children, endIndex } = parseConcatenationOrLiteralNode(str, equalsIndex + 1, " ");
	return createNode(str, {
		name: nameNode,
		startIndex,
		endIndex,
		type: NodeType.Assignment,
		operator,
		children,
		complete: children[children.length - 1].complete
	});
};
var parseAssignments = (str, index) => {
	const variables = [];
	let lastVariableEnd = index;
	while (lastVariableEnd < str.length) {
		const nextTokenStart = nextWordIndex(str, lastVariableEnd);
		if (/^[\w[\]]+\+?=.*/.test(str.slice(nextTokenStart))) {
			const assignmentNode = parseAssignmentNode(str, nextTokenStart);
			variables.push(assignmentNode);
			lastVariableEnd = assignmentNode.endIndex;
		} else return variables;
	}
	return variables;
};
var parseAssignmentListNodeOrCommandNode = (str, startIndex, terminalChar) => {
	const assignments = parseAssignments(str, startIndex);
	if (assignments.length > 0) {
		const lastAssignment = assignments[assignments.length - 1];
		const operator = parseOperator(str, nextWordIndex(str, lastAssignment.endIndex));
		let command;
		if (!operator && lastAssignment.complete && lastAssignment.endIndex !== str.length) command = parseCommand(str, lastAssignment.endIndex, terminalChar);
		return createNode(str, {
			type: NodeType.AssignmentList,
			startIndex,
			endIndex: command ? command.endIndex : lastAssignment.endIndex,
			hasCommand: !!command,
			children: command ? [...assignments, command] : assignments
		});
	}
	return parseCommand(str, startIndex, terminalChar);
};
var reduceStatements = (str, lhs, rhs, type) => createNode(str, {
	type,
	startIndex: lhs.startIndex,
	children: rhs.type === type ? [lhs, ...rhs.children] : [lhs, rhs],
	endIndex: rhs.endIndex,
	complete: lhs.complete && rhs.complete
});
function parseStatement(str, index, terminalChar) {
	let i = nextWordIndex(str, index);
	i = i === -1 ? index : i;
	let statement = null;
	if (["{", "("].includes(str.charAt(i))) {
		const isCompound = str.charAt(i) === "{";
		const endChar = isCompound ? "}" : ")";
		const { statements: children, terminatorIndex } = parseStatements(str, i + 1, endChar, isCompound);
		const hasChildren = children.length > 0;
		const terminated = terminatorIndex !== -1;
		let endIndex = terminatorIndex + 1;
		if (!terminated) endIndex = hasChildren ? children[children.length - 1].endIndex : str.length;
		statement = createNode(str, {
			startIndex: i,
			type: isCompound ? NodeType.CompoundStatement : NodeType.Subshell,
			endIndex,
			complete: terminated && hasChildren,
			children
		});
	} else statement = parseAssignmentListNodeOrCommandNode(str, i, terminalChar);
	i = statement.endIndex;
	const opIndex = nextWordIndex(str, i);
	const op = opIndex !== -1 && parseOperator(str, opIndex);
	if (!op || op === ";" || op === "&" || op === "&;" || opIndex !== -1 && terminalChar && str.charAt(opIndex) === terminalChar) return statement;
	const rightHandStatement = parseStatement(str, opIndex + op.length, terminalChar);
	if (op === "&&" || op === "||") return reduceStatements(str, statement, rightHandStatement, NodeType.List);
	if (op === "|" || op === "|&") {
		if (rightHandStatement.type === NodeType.List) {
			const [oldFirstChild, ...otherChildren] = rightHandStatement.children;
			const newFirstChild = reduceStatements(str, statement, oldFirstChild, NodeType.Pipeline);
			return createNode(str, {
				type: NodeType.List,
				startIndex: newFirstChild.startIndex,
				children: [newFirstChild, ...otherChildren],
				endIndex: rightHandStatement.endIndex,
				complete: newFirstChild.complete && rightHandStatement.complete
			});
		}
		return reduceStatements(str, statement, rightHandStatement, NodeType.Pipeline);
	}
	return statement;
}
var parse = (str) => createNode(str, {
	startIndex: 0,
	type: NodeType.Program,
	children: parseStatements(str, 0, "").statements
});
//#endregion
//#region vendor/amazon-q-autocomplete/packages/shell-parser/src/errors.ts
var SubstituteAliasError = createErrorInstance("SubstituteAliasError");
var ConvertCommandError = createErrorInstance("ConvertCommandError");
//#endregion
//#region vendor/amazon-q-autocomplete/packages/shell-parser/src/command.ts
var descendantAtIndex = (node, index, type) => {
	if (node.startIndex <= index && index <= node.endIndex) {
		const descendant = node.children.map((child) => descendantAtIndex(child, index, type)).find(Boolean);
		if (descendant) return descendant;
		return !type || node.type === type ? node : null;
	}
	return null;
};
var createTextToken = (command, index, text, originalNode) => {
	const { tree, originalTree, tokens } = command;
	let indexDiff = 0;
	const tokenIndex = tokens.findIndex((token) => index < token.originalNode.startIndex);
	const token = tokens[tokenIndex];
	if (tokenIndex === 0) indexDiff = token.node.startIndex - token.originalNode.startIndex;
	else if (tokenIndex === -1) indexDiff = tree.text.length - originalTree.text.length;
	else indexDiff = token.node.endIndex - token.originalNode.endIndex;
	return {
		originalNode: originalNode || createTextNode(originalTree.text, index, text),
		node: createTextNode(text, index + indexDiff, text),
		text
	};
};
var convertCommandNodeToCommand = (tree) => {
	if (tree.type !== NodeType.Command) throw new ConvertCommandError("Cannot get tokens from non-command node");
	const command = {
		originalTree: tree,
		tree,
		tokens: tree.children.map((child) => ({
			originalNode: child,
			node: child,
			text: child.innerText
		}))
	};
	const { children, endIndex, text } = tree;
	if (+(children.length === 0 || children[children.length - 1].endIndex) < endIndex && text.endsWith(" ")) command.tokens.push(createTextToken(command, endIndex, ""));
	return command;
};
var shiftByAmount = (node, shift) => ({
	...node,
	startIndex: node.startIndex + shift,
	endIndex: node.endIndex + shift,
	children: node.children.map((child) => shiftByAmount(child, shift))
});
var substituteAlias = (command, token, alias) => {
	if (command.tokens.find((t) => t === token) === void 0) throw new SubstituteAliasError("Token not in command");
	const { tree } = command;
	const preAliasChars = token.node.startIndex - tree.startIndex;
	const postAliasChars = token.node.endIndex - tree.endIndex;
	const parseTree = shiftByAmount(parse(`${`${tree.text.slice(0, preAliasChars)}`}${alias}${postAliasChars ? `${tree.text.slice(postAliasChars)}` : ""}`), tree.startIndex);
	if (parseTree.children.length !== 1) throw new SubstituteAliasError("Invalid alias");
	const newCommand = convertCommandNodeToCommand(parseTree.children[0]);
	const [aliasStart, aliasEnd] = [token.node.startIndex, token.node.startIndex + alias.length];
	let tokenIndexDiff = 0;
	let lastTokenInAlias = false;
	const tokens = newCommand.tokens.map((newToken, index) => {
		const tokenInAlias = aliasStart < newToken.node.endIndex && newToken.node.startIndex < aliasEnd;
		tokenIndexDiff += tokenInAlias && lastTokenInAlias ? 1 : 0;
		const { originalNode } = command.tokens[index - tokenIndexDiff];
		lastTokenInAlias = tokenInAlias;
		return {
			...newToken,
			originalNode
		};
	});
	if (newCommand.tokens.length - command.tokens.length !== tokenIndexDiff) throw new SubstituteAliasError("Error substituting alias");
	return {
		originalTree: command.originalTree,
		tree: newCommand.tree,
		tokens
	};
};
var expandCommand = (command, _cursorIndex, aliases) => {
	let expanded = command;
	const usedAliases = /* @__PURE__ */ new Set();
	let [name] = expanded.tokens;
	while (expanded.tokens.length > 1 && name && aliases[name.text] && !usedAliases.has(name.text)) {
		const aliasValue = aliases[name.text].replace(/^'(.*)'$/g, "$1");
		try {
			expanded = substituteAlias(expanded, name, aliasValue);
		} catch (_err) {}
		usedAliases.add(name.text);
		[name] = expanded.tokens;
	}
	return expanded;
};
var getCommand = (buffer, aliases, cursorIndex) => {
	const index = cursorIndex === void 0 ? buffer.length : cursorIndex;
	const commandNode = descendantAtIndex(parse(buffer), index, NodeType.Command);
	if (commandNode === null) return null;
	return expandCommand(convertCommandNodeToCommand(commandNode), index, aliases);
};
NodeType.Program, NodeType.CompoundStatement, NodeType.Subshell, NodeType.Pipeline, NodeType.List, NodeType.Command;
var UpdateStateError = createErrorInstance("UpdateStateError");
//#endregion
//#region vendor/amazon-q-autocomplete/packages/autocomplete-parser/src/caches.ts
var allCaches = [];
var createCache = () => {
	const cache = /* @__PURE__ */ new Map();
	allCaches.push(cache);
	return cache;
};
var resetCaches = () => {
	allCaches.forEach((cache) => {
		cache.clear();
	});
};
window.resetCaches = resetCaches;
var specCache = createCache();
var generateSpecCache = createCache();
window.listCache = () => {
	console.log(specCache);
	console.log(generateSpecCache);
};
//#endregion
//#region vendor/amazon-q-autocomplete/packages/autocomplete-parser/src/parseArguments.ts
var TokenType = /* @__PURE__ */ function(TokenType) {
	TokenType["None"] = "none";
	TokenType["Subcommand"] = "subcommand";
	TokenType["Option"] = "option";
	TokenType["OptionArg"] = "option_arg";
	TokenType["SubcommandArg"] = "subcommand_arg";
	TokenType["Composite"] = "composite";
	return TokenType;
}({});
var createArgState = (args) => {
	const updatedArgs = [];
	for (const arg of args ?? []) {
		const updatedGenerators = /* @__PURE__ */ new Set();
		for (let i = 0; i < arg.generators.length; i += 1) {
			const generator = arg.generators[i];
			const templateArray = makeArray(generator.template ?? []);
			let updatedGenerator;
			if (templateArray.includes("filepaths")) updatedGenerator = import_lib.filepaths;
			else if (templateArray.includes("folders")) updatedGenerator = import_lib.folders;
			if (updatedGenerator && generator.filterTemplateSuggestions) updatedGenerator.filterTemplateSuggestions = generator.filterTemplateSuggestions;
			updatedGenerators.add(updatedGenerator ?? generator);
		}
		updatedArgs.push({
			...arg,
			generators: [...updatedGenerators]
		});
	}
	return {
		args: updatedArgs.length > 0 ? updatedArgs : null,
		index: 0
	};
};
var flattenAnnotations = (annotations) => {
	const result = [];
	for (let i = 0; i < annotations.length; i += 1) {
		const annotation = annotations[i];
		if (annotation.type === TokenType.Composite) result.push(...annotation.subtokens);
		else result.push(annotation);
	}
	return result;
};
var optionsAreEqual = (a, b) => a.name.some((name) => b.name.includes(name));
var countEqualOptions = (option, options) => options.reduce((count, opt) => optionsAreEqual(option, opt) ? count + 1 : count, 0);
var updateArgState = (argState) => {
	const { args, index, variadicCount } = argState;
	if (args && args[index] && args[index].isVariadic) return {
		args,
		index,
		variadicCount: (variadicCount || 0) + 1
	};
	if (args && args[index] && index < args.length - 1) return {
		args,
		index: index + 1
	};
	return {
		args: null,
		index: 0
	};
};
var getCurrentArg = (argState) => argState.args && argState.args[argState.index] || null;
var isMandatoryOrVariadic = (arg) => !!arg && (arg.isVariadic || !arg.isOptional);
var preferOptionArg = (state) => isMandatoryOrVariadic(getCurrentArg(state.optionArgState)) || !getCurrentArg(state.subcommandArgState);
var getArgState = (state) => preferOptionArg(state) ? state.optionArgState : state.subcommandArgState;
var canConsumeOptions = (state) => {
	const { subcommandArgState, optionArgState, isEndOfOptions, haveEnteredSubcommandArgs, completionObj } = state;
	if (haveEnteredSubcommandArgs && completionObj.parserDirectives?.optionsMustPrecedeArguments === true) return false;
	if (isEndOfOptions) return false;
	const subcommandArg = getCurrentArg(subcommandArgState);
	const optionArg = getCurrentArg(optionArgState);
	if (isMandatoryOrVariadic(getCurrentArg(optionArgState))) {
		if (optionArg?.isVariadic && optionArgState.variadicCount && optionArg.optionsCanBreakVariadicArg !== false) return true;
		return false;
	}
	if (subcommandArg && subcommandArgState.variadicCount && subcommandArg?.optionsCanBreakVariadicArg === false) return false;
	return true;
};
var findOption = (spec, token) => {
	const option = spec.options[token] || spec.persistentOptions[token];
	if (!option) throw new UpdateStateError(`Option not found: ${token}`);
	return option;
};
var findSubcommand = (spec, token) => {
	const subcommand = spec.subcommands[token];
	if (!subcommand) throw new UpdateStateError("Subcommand not found");
	return subcommand;
};
var updateStateForSubcommand = (state, token, isFinalToken = false) => {
	const { completionObj, haveEnteredSubcommandArgs } = state;
	if (!completionObj.subcommands) throw new UpdateStateError("No subcommands");
	if (haveEnteredSubcommandArgs) throw new UpdateStateError("Already entered subcommand args");
	const newCompletionObj = findSubcommand(state.completionObj, token);
	const annotations = [...state.annotations, {
		text: token,
		type: TokenType.Subcommand
	}];
	if (isFinalToken) return {
		...state,
		annotations
	};
	if (!newCompletionObj.parserDirectives && completionObj.parserDirectives) newCompletionObj.parserDirectives = completionObj.parserDirectives;
	Object.assign(newCompletionObj.persistentOptions, completionObj.persistentOptions);
	return {
		...state,
		annotations,
		completionObj: newCompletionObj,
		passedOptions: [],
		optionArgState: createArgState(),
		subcommandArgState: createArgState(newCompletionObj.args)
	};
};
var updateStateForOption = (state, token, isFinalToken = false) => {
	const option = findOption(state.completionObj, token);
	let { isRepeatable } = option;
	if (isRepeatable === false) isRepeatable = 1;
	if (isRepeatable !== true && isRepeatable !== void 0) {
		const currentRepetitions = countEqualOptions(option, state.passedOptions);
		if (currentRepetitions >= isRepeatable) throw new UpdateStateError(`Cannot pass option again, already passed ${currentRepetitions} times, and can only be passed ${isRepeatable} times`);
	}
	const annotations = [...state.annotations, {
		text: token,
		type: TokenType.Option
	}];
	if (isFinalToken) return {
		...state,
		annotations
	};
	return {
		...state,
		annotations,
		passedOptions: [...state.passedOptions, option],
		optionArgState: createArgState(option.args)
	};
};
var updateStateForOptionArg = (state, token, isFinalToken = false) => {
	if (!getCurrentArg(state.optionArgState)) throw new UpdateStateError("Cannot consume option arg.");
	const annotations = [...state.annotations, {
		text: token,
		type: TokenType.OptionArg
	}];
	if (isFinalToken) return {
		...state,
		annotations
	};
	return {
		...state,
		annotations,
		optionArgState: updateArgState(state.optionArgState)
	};
};
var updateStateForSubcommandArg = (state, token, isFinalToken = false) => {
	if (!getCurrentArg(state.subcommandArgState)) throw new UpdateStateError("Cannot consume subcommand arg.");
	const annotations = [...state.annotations, {
		text: token,
		type: TokenType.SubcommandArg
	}];
	if (isFinalToken) return {
		...state,
		annotations
	};
	return {
		...state,
		annotations,
		subcommandArgState: updateArgState(state.subcommandArgState),
		haveEnteredSubcommandArgs: true
	};
};
var updateStateForChainedOptionToken = (state, token, isFinalToken = false) => {
	if (isFinalToken && ["-", "--"].includes(token)) throw new UpdateStateError("Final token, not consuming as option");
	if (token === "--") return {
		...state,
		isEndOfOptions: true,
		annotations: [...state.annotations, {
			text: token,
			type: TokenType.Option
		}],
		optionArgState: {
			args: null,
			index: 0
		}
	};
	const { parserDirectives } = state.completionObj;
	if (parserDirectives?.flagsArePosixNoncompliant || token.startsWith("--") || !token.startsWith("-")) {
		const separatorMatches = firstMatchingToken(token, new Set(parserDirectives?.optionArgSeparators || "="));
		if (separatorMatches) {
			const matchedSeparator = separatorMatches[0];
			const [flag, ...optionArgParts] = token.split(matchedSeparator);
			const optionArg = optionArgParts.join(matchedSeparator);
			const optionState = updateStateForOption(state, flag);
			if ((optionState.optionArgState.args?.length ?? 0) > 1) throw new UpdateStateError("Cannot pass argument with separator: option takes multiple args");
			return {
				...updateStateForOptionArg(optionState, optionArg, isFinalToken),
				annotations: [...state.annotations, {
					type: TokenType.Composite,
					text: token,
					subtokens: [{
						type: TokenType.Option,
						text: `${flag}${matchedSeparator}`,
						tokenName: flag
					}, {
						type: TokenType.OptionArg,
						text: optionArg
					}]
				}]
			};
		}
		const finalState = updateStateForOption(state, token, isFinalToken);
		const option = findOption(state.completionObj, token);
		return option.requiresEquals || option.requiresSeparator ? {
			...finalState,
			optionArgState: {
				args: null,
				index: 0
			}
		} : finalState;
	}
	let optionState = state;
	let optionArg = "";
	const subtokens = [];
	let { passedOptions } = state;
	for (let i = 1; i < token.length; i += 1) {
		const [optionFlag, remaining] = [`-${token[i]}`, token.slice(i + 1)];
		passedOptions = optionState.passedOptions;
		try {
			optionState = updateStateForOption(optionState, optionFlag);
		} catch (err) {
			if (i > 1) {
				optionArg = token.slice(i);
				break;
			}
			throw err;
		}
		subtokens.push({
			type: TokenType.Option,
			text: i === 1 ? optionFlag : token[i],
			tokenName: optionFlag
		});
		if (isMandatoryOrVariadic(getCurrentArg(optionState.optionArgState))) {
			optionArg = remaining;
			break;
		}
	}
	if (optionArg) {
		if ((optionState.optionArgState.args?.length ?? 0) > 1) throw new UpdateStateError("Cannot chain option argument: option takes multiple args");
		optionState = updateStateForOptionArg(optionState, optionArg, isFinalToken);
		passedOptions = optionState.passedOptions;
		subtokens.push({
			type: TokenType.OptionArg,
			text: optionArg
		});
	}
	return {
		...optionState,
		annotations: [...state.annotations, {
			type: TokenType.Composite,
			text: token,
			subtokens
		}],
		passedOptions: isFinalToken ? passedOptions : optionState.passedOptions
	};
};
var canConsumeSubcommands = (state) => !isMandatoryOrVariadic(getCurrentArg(state.optionArgState)) && !state.haveEnteredSubcommandArgs;
function updateState(state, token, isFinalToken = false) {
	if (canConsumeSubcommands(state)) try {
		return updateStateForSubcommand(state, token, isFinalToken);
	} catch (_err) {}
	if (canConsumeOptions(state)) try {
		return updateStateForChainedOptionToken(state, token, isFinalToken);
	} catch (_err) {}
	if (preferOptionArg(state)) try {
		return updateStateForOptionArg(state, token, isFinalToken);
	} catch (_err) {}
	return updateStateForSubcommandArg(state, token, isFinalToken);
}
var getInitialState = (spec, text, specLocation) => ({
	completionObj: spec,
	passedOptions: [],
	annotations: text && specLocation ? [{
		text,
		type: TokenType.Subcommand,
		spec,
		specLocation
	}] : [],
	commandIndex: 0,
	optionArgState: createArgState(),
	subcommandArgState: createArgState(spec.args),
	haveEnteredSubcommandArgs: false,
	isEndOfOptions: false
});
var getResultFromState = (state) => {
	const { completionObj, passedOptions, commandIndex, annotations } = state;
	const lastAnnotation = annotations[annotations.length - 1];
	let argState = getArgState(state);
	let searchTerm = lastAnnotation?.text ?? "";
	let onlySuggestArgs = state.isEndOfOptions;
	if (lastAnnotation?.type === TokenType.Composite) {
		argState = state.optionArgState;
		const lastSubtoken = lastAnnotation.subtokens[lastAnnotation.subtokens.length - 1];
		if (lastSubtoken.type === TokenType.OptionArg) {
			searchTerm = lastSubtoken.text;
			onlySuggestArgs = true;
		}
	}
	const currentArg = getCurrentArg(argState);
	let suggestionFlags = SuggestionFlag.Args;
	if (!onlySuggestArgs) {
		if (canConsumeSubcommands(state)) suggestionFlags |= SuggestionFlag.Subcommands;
		if (canConsumeOptions(state)) suggestionFlags |= SuggestionFlag.Options;
	}
	return {
		completionObj,
		passedOptions,
		commandIndex,
		annotations,
		currentArg,
		searchTerm,
		suggestionFlags
	};
};
getResultFromState(getInitialState({
	name: [""],
	subcommands: {},
	options: {},
	persistentOptions: {},
	parserDirectives: {},
	args: []
}));
createCache();
createCache();
//#endregion
export { SuggestionFlag, TokenType, convertSubcommand, countEqualOptions, createArgState, findOption, findSubcommand, flattenAnnotations, getCommand, getInitialState, getResultFromState, initializeDefault, optionsAreEqual, updateArgState, updateState };
