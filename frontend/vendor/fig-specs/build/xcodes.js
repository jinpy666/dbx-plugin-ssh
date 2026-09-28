//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/xcodes.ts
var processXcodeList = (out, tokens) => out.split("\n").reverse().map((line) => ({
	name: line.slice(0, line.indexOf(" (")),
	icon: line.includes("Selected") ? "⭐️" : line.includes("Installed") ? "🔨" : tokens.includes("select") || tokens.includes("uninstall") ? "🔨" : "⬇️",
	description: line.slice(line.indexOf("(")).replace(/[\(\)]/g, "")
}));
var allXcodes = {
	script: ["xcodes", "list"],
	postProcess: processXcodeList
};
var installedXcodes = {
	script: ["xcodes", "installed"],
	postProcess: processXcodeList
};
var completionSpec = {
	name: "xcodes",
	description: "Manage the Xcode versions installed on your Mac",
	subcommands: [
		{
			name: "help",
			icon: "ℹ️",
			args: {
				name: "command",
				template: "help",
				isOptional: true
			}
		},
		{
			name: "download",
			description: "Download a specific version of Xcode",
			icon: "⬇️",
			options: [
				{
					name: "--latest",
					description: "Update and then install the latest non-prerelease version available"
				},
				{
					name: "--latest-prerelease",
					description: "Update and then install the latest prerelease version available, including GM seeds and GMs"
				},
				{
					name: "--aria2",
					description: "The path to an aria2 executable. Searches $PATH by default",
					args: {
						name: "aria2",
						template: "filepaths"
					}
				},
				{
					name: "--no-aria2",
					description: "Don't use aria2 to download Xcode, even if it's available"
				},
				{
					name: "--directory",
					description: "The directory where your Xcodes are installed. Defaults to /Applications",
					args: {
						name: "directory",
						template: "folders"
					}
				},
				{
					name: "--data-source",
					description: "The data source for available Xcode versions. (default: xcodereleases)",
					args: {
						name: "dataSource",
						suggestions: ["xcodereleases", "apple"]
					}
				},
				{
					name: "--color",
					description: "Color the output"
				},
				{
					name: "--no-color",
					description: "Do not color the output"
				}
			],
			args: {
				name: "version",
				description: "The version to install",
				isOptional: true,
				generators: allXcodes
			}
		},
		{
			name: "install",
			description: "Download and install a specific version of Xcode",
			icon: "⬇️",
			options: [
				{
					name: "--path",
					description: "Local path to Xcode.xip",
					args: {
						name: "path",
						template: "filepaths"
					}
				},
				{
					name: "--latest",
					description: "Update and then install the latest non-prerelease version available"
				},
				{
					name: "--latest-prerelease",
					description: "Update and then install the latest prerelease version available, including GM seeds and GMs"
				},
				{
					name: "--aria2",
					description: "The path to an aria2 executable. Searches $PATH by default",
					args: {
						name: "aria2",
						template: "filepaths"
					}
				},
				{
					name: "--no-aria2",
					description: "Don't use aria2 to download Xcode, even if it's available"
				},
				{
					name: "--experimental-unxip",
					description: "Use the experimental unxip functionality. May speed up unarchiving by up to 2-3x"
				},
				{
					name: "--directory",
					description: "The directory where your Xcodes are installed. Defaults to /Applications",
					args: {
						name: "directory",
						template: "folders"
					}
				},
				{
					name: "--data-source",
					description: "The data source for available Xcode versions. (default: xcodereleases)",
					args: {
						name: "dataSource",
						suggestions: ["xcodereleases", "apple"]
					}
				},
				{
					name: "--color",
					description: "Color the output"
				},
				{
					name: "--no-color",
					description: "Do not color the output"
				}
			],
			args: {
				name: "version",
				description: "The version to install",
				isOptional: true,
				generators: allXcodes
			}
		},
		{
			name: "installed",
			description: "List the versions of Xcode that are installed",
			icon: "🔨",
			options: [
				{
					name: "--directory",
					description: "The directory where your Xcodes are installed. Defaults to /Applications",
					args: {
						name: "directory",
						template: "folders"
					}
				},
				{
					name: "--color",
					description: "Color the output"
				},
				{
					name: "--no-color",
					description: "Do not color the output"
				}
			]
		},
		{
			name: "list",
			description: "List all versions of Xcode available to install",
			icon: "🔍",
			options: [
				{
					name: "--directory",
					description: "The directory where your Xcodes are installed. Defaults to /Applications",
					args: {
						name: "directory",
						template: "folders"
					}
				},
				{
					name: "--data-source",
					description: "The data source for available Xcode versions. (default: xcodereleases)",
					args: {
						name: "dataSource",
						suggestions: ["xcodereleases", "apple"]
					}
				},
				{
					name: "--color",
					description: "Color the output"
				},
				{
					name: "--no-color",
					description: "Do not color the output"
				}
			]
		},
		{
			name: "select",
			description: "Change the selected Xcode",
			icon: "☑️",
			options: [
				{
					name: ["-p", "--print-path"],
					description: "Print the path of the selected Xcode"
				},
				{
					name: "--directory",
					description: "The directory where your Xcodes are installed. Defaults to /Applications",
					args: {
						name: "directory",
						template: "folders"
					}
				},
				{
					name: "--color",
					description: "Color the output"
				},
				{
					name: "--no-color",
					description: "Do not color the output"
				}
			],
			args: {
				name: "version-or-path",
				description: "Version or path of Xcode to select",
				isOptional: true,
				generators: installedXcodes
			}
		},
		{
			name: "uninstall",
			description: "Uninstall a version of Xcode",
			icon: "❌",
			isDangerous: true,
			args: {
				name: "version",
				isOptional: true,
				generators: installedXcodes,
				isDangerous: true
			},
			options: [
				{
					name: "--directory",
					description: "The directory where your Xcodes are installed. Defaults to /Applications",
					args: {
						name: "directory",
						template: "folders"
					}
				},
				{
					name: "--color",
					description: "Color the output"
				},
				{
					name: "--no-color",
					description: "Do not color the output"
				}
			]
		},
		{
			name: "update",
			description: "Update the list of available versions of Xcode",
			icon: "🔄",
			options: [
				{
					name: "--directory",
					description: "The directory where your Xcodes are installed. Defaults to /Applications",
					args: {
						name: "directory",
						template: "folders"
					}
				},
				{
					name: "--data-source",
					description: "The data source for available Xcode versions. (default: xcodereleases)",
					args: {
						name: "dataSource",
						suggestions: ["xcodereleases", "apple"]
					}
				},
				{
					name: "--color",
					description: "Color the output"
				},
				{
					name: "--no-color",
					description: "Do not color the output"
				}
			]
		},
		{
			name: "version",
			description: "Print the version number of xcodes itself",
			options: [
				{
					name: "--color",
					description: "Color the output"
				},
				{
					name: "--no-color",
					description: "Do not color the output"
				},
				{
					name: ["--help", "-h"],
					description: "Show help information"
				}
			]
		},
		{
			name: "signout",
			description: "Clears the stored username and password",
			options: [{
				name: "--color",
				description: "Color the output"
			}, {
				name: "--no-color",
				description: "Do not color the output"
			}]
		}
	],
	options: [{
		name: ["--help", "-h"],
		description: "Show help information",
		isPersistent: true
	}]
};
//#endregion
export { completionSpec as default };
