//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/example/trigger.ts
var _prefix_string_for_file_and_folder_suggestions = "file://";
var completionSpec = {
	name: "trigger_example",
	description: "",
	subcommands: [{
		name: "test",
		args: {
			name: "FILE/FOLDER",
			description: "must start with file://",
			generators: {
				script: (tokens) => {
					var baseLsCommand = ["ls", "-1ApL"];
					var whatHasUserTyped = tokens[tokens.length - 1];
					if (whatHasUserTyped.startsWith(_prefix_string_for_file_and_folder_suggestions)) whatHasUserTyped = whatHasUserTyped.slice(7);
					else return ["echo", "file://"];
					var folderPath = "";
					var lastSlashIndex = whatHasUserTyped.lastIndexOf("/");
					if (lastSlashIndex > -1) {
						if (whatHasUserTyped.startsWith("~/")) folderPath = whatHasUserTyped.slice(0, lastSlashIndex + 1);
						else if (whatHasUserTyped.startsWith("/")) {
							if (lastSlashIndex === 0) folderPath = "/";
							else folderPath = whatHasUserTyped.slice(0, lastSlashIndex + 1);
						} else folderPath = whatHasUserTyped.slice(0, lastSlashIndex + 1);
					}
					return [...baseLsCommand, folderPath];
				},
				postProcess: (out) => {
					if (out.trim() === _prefix_string_for_file_and_folder_suggestions) return [{
						name: _prefix_string_for_file_and_folder_suggestions,
						insertValue: _prefix_string_for_file_and_folder_suggestions
					}];
					const sortFnStrings = (a, b) => {
						return a.localeCompare(b);
					};
					const alphabeticalSortFilesAndFolders = (arr) => {
						var dots_arr = [];
						var other_arr = [];
						arr.map((elm) => {
							if (elm.toLowerCase() == ".ds_store") return;
							if (elm.slice(0, 1) === ".") dots_arr.push(elm);
							else other_arr.push(elm);
						});
						return [
							...other_arr.sort(sortFnStrings),
							"../",
							...dots_arr.sort(sortFnStrings)
						];
					};
					var temp_array = alphabeticalSortFilesAndFolders(out.split("\n"));
					var final_array = [];
					temp_array.forEach((item) => {
						if (!(item === "" || item === null || item === void 0)) {
							const outputType = item.slice(-1) === "/" ? "folder" : "file";
							final_array.push({
								type: outputType,
								name: item,
								insertValue: item
							});
						}
					});
					return final_array;
				},
				trigger: (newToken, oldToken) => {
					if (!newToken.startsWith(_prefix_string_for_file_and_folder_suggestions)) {
						if (!oldToken) return false;
						if (oldToken.startsWith(_prefix_string_for_file_and_folder_suggestions)) return true;
						return false;
					}
					if (newToken.lastIndexOf("/") !== oldToken.lastIndexOf("/")) return true;
					else return false;
				},
				getQueryTerm: (token) => {
					if (!token.startsWith(_prefix_string_for_file_and_folder_suggestions)) return token;
					return token.slice(token.lastIndexOf("/") + 1);
				}
			}
		}
	}]
};
//#endregion
export { completionSpec as default };
