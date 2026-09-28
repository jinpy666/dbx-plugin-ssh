//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/tldr.ts
var tldrRc = `~/.tldrc/tldr`;
var android = `${tldrRc}/pages/android/`;
var common = `${tldrRc}/pages/common/`;
var linux = `${tldrRc}/pages/linux/`;
var osx = `${tldrRc}/pages/osx/`;
var sunos = `${tldrRc}/pages/sunos/`;
var windows = `${tldrRc}/pages/windows/`;
var isMarkDownRegex = /* @__PURE__ */ new RegExp(/^.*\.md$/);
var wholeTldrPages = { custom: async (tokens, executeShellCommand, context) => {
	const { stdout } = await executeShellCommand({
		command: "ls",
		args: ["-Al", ...[
			android,
			common,
			linux,
			osx,
			sunos,
			windows
		].map((path) => path.replace(/^~/, context.environmentVariables["HOME"]))]
	});
	return stdout.split("\n").filter((line) => isMarkDownRegex.test(line)).map((line) => {
		return {
			name: line.split(" ").at(-1).slice(0, -3),
			description: "Tldr page",
			icon: "fig://icon?type=string"
		};
	});
} };
var linuxTldrPages = {
	script: [
		"bash",
		"-c",
		`command ls -Al ${linux} 2>/dev/null`
	],
	postProcess: (out) => {
		return out.split("\n").filter((line) => isMarkDownRegex.test(line)).map((line) => {
			return {
				name: line.split(" ").at(-1).slice(0, -3),
				description: "Tldr page",
				icon: "fig://icon?type=string"
			};
		});
	}
};
var osxTldrPages = {
	script: [
		"bash",
		"-c",
		`command ls -l ${osx} 2>/dev/null`
	],
	postProcess: (out) => {
		return out.split("\n").filter((line) => isMarkDownRegex.test(line)).map((line) => {
			return {
				name: line.split(" ").at(-1).slice(0, -3),
				description: "Tldr page",
				icon: "fig://icon?type=string"
			};
		});
	}
};
var sunosTldrPages = {
	script: [
		"bash",
		"-c",
		`command ls -l ${sunos} 2>/dev/null`
	],
	postProcess: (out) => {
		return out.split("\n").filter((line) => isMarkDownRegex.test(line)).map((line) => {
			return {
				name: line.split(" ").at(-1).slice(0, -3),
				description: "Tldr page",
				icon: "fig://icon?type=string"
			};
		});
	}
};
var completionSpec = {
	name: "tldr",
	description: "A simpler man page than the existing man page",
	args: { generators: wholeTldrPages },
	options: [
		{
			name: ["-h", "--help"],
			description: "Display help for command"
		},
		{
			name: ["-s", "--search"],
			description: "Search all pages for the query",
			args: { name: "query" }
		},
		{
			name: "--linux",
			description: "Show command page for Linux",
			args: { generators: linuxTldrPages }
		},
		{
			name: "--osx",
			description: "Show command page for OSX",
			args: { generators: osxTldrPages }
		},
		{
			name: "--sunos",
			description: "Show command page for SunOS",
			args: { generators: sunosTldrPages }
		},
		{
			name: ["-l", "--list"],
			description: "Show all pages for current platform"
		},
		{
			name: ["-u", "--update"],
			description: "Download the latest pages and generate search index"
		},
		{
			name: ["-c", "--clear-cache"],
			description: "Delete the entire local cache"
		},
		{
			name: ["--platform", "-p"],
			description: "Select platform",
			args: {
				name: "platform",
				suggestions: [
					"linux",
					"osx",
					"sunos",
					"windows",
					"common"
				]
			}
		}
	]
};
//#endregion
export { completionSpec as default };
