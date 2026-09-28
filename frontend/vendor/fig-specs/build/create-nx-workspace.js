//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/create-nx-workspace.ts
var boolArg = (name, isOptional) => ({
	name,
	isOptional,
	suggestions: [{
		name: "true",
		icon: "✅"
	}, {
		name: "false",
		icon: "❌"
	}]
});
var workspaceNameArg = {
	name: "workspace",
	description: "The name of the workspace"
};
var completionSpec = {
	name: "create-nx-workspace",
	description: "Create a new Nx workspace",
	options: [
		{
			name: "--name",
			description: "Workspace name (e.g., org name)",
			args: workspaceNameArg
		},
		{
			name: "--preset",
			description: "What to create in a new workspace (options: \"empty\", \"npm\", \"web-components\", \"angular\", \"angular-nest\", \"react\", \"react-express\", \"react-native\", \"next\", \"gatsby\", \"nest\", \"express\")",
			args: {
				name: "preset",
				suggestions: [
					{
						name: "empty",
						icon: "https://github.com/nrwl/nx/raw/master/images/nx-logo.png",
						description: "Empty [an empty workspace with a layout that works best for building apps]"
					},
					{
						name: "npm",
						icon: "fig://icon?type=npm",
						description: "Npm [an empty workspace set up to publish npm packages (similar to and compatible with yarn workspaces)]"
					},
					{
						name: "web-components",
						icon: "https://web-components-resources.appspot.com/static/logo.svg",
						description: "Web components [a workspace with a single app built using web components]"
					},
					{
						name: "angular",
						icon: "https://angular.io/assets/images/logos/angular/angular.svg",
						description: "Angular [a workspace with a single Angular application]"
					},
					{
						name: "angular-nest",
						icon: "https://angular.io/assets/images/logos/angular/angular.svg",
						description: "Angular-nest [a workspace with a full stack application (Angular + Nest)]"
					},
					{
						name: "react",
						icon: "https://reactjs.org/favicon.ico",
						description: "React [a workspace with a single React application]"
					},
					{
						name: "react-express",
						icon: "https://reactjs.org/favicon.ico",
						description: "React-express [a workspace with a full stack application (React + Express)]"
					},
					{
						name: "react-native",
						icon: "https://reactjs.org/favicon.ico",
						description: "React-native [a workspace with a single React Native application]"
					},
					{
						name: "next",
						icon: "https://nextjs.org/static/favicon/favicon.ico",
						description: "Next.js [a workspace with a single Next.js application]"
					},
					{
						name: "gatsby",
						icon: "https://www.gatsbyjs.com/favicon-32x32.png?v=3ad5294f3fa6c06e2d07ab07c76df2cf",
						description: "Gatsby [a workspace with a single Gatsby application]"
					},
					{
						name: "nest",
						icon: "https://nestjs.com/favicon.264d6486.ico",
						description: "Nest [a workspace with a single Nest application]"
					},
					{
						name: "express",
						icon: "https://expressjs.com/images/favicon.png",
						description: "Express [a workspace with a single Express application]"
					}
				]
			}
		},
		{
			name: "--appName",
			description: "The name of the application created by some presets",
			args: {
				name: "appName",
				isOptional: true
			}
		},
		{
			name: "--cli",
			description: "CLI to power the Nx workspace (options: \"nx\", \"angular\")",
			args: {
				name: "cli",
				suggestions: [{
					name: "nx",
					icon: "https://github.com/nrwl/nx/raw/master/images/nx-logo.png"
				}, {
					name: "angular",
					icon: "https://angular.io/assets/images/logos/angular/angular.svg"
				}]
			}
		},
		{
			name: "--style",
			description: "Default style option to be used when a non-empty preset is selected options: (\"css\", \"scss\", \"less\") plus (\"styl\") for all non-Angular and (\"styled-components\", \"@emotion/styled\", \"styled-jsx\") for React, Next.js, Gatsby",
			args: {
				name: "style",
				suggestions: [
					{
						name: "css",
						icon: "https://upload.wikimedia.org/wikipedia/commons/6/62/CSS3_logo.svg",
						description: "CSS"
					},
					{
						name: "scss",
						icon: "https://sass-lang.com/favicon.ico",
						description: "SASS(.scss) [ http://sass-lang.com ]"
					},
					{
						name: "less",
						icon: "https://lesscss.org/public/ico/favicon.ico",
						description: "LESS [ http://lesscss.org ]"
					},
					{
						name: "styl",
						icon: "https://stylus-lang.com/favicon.ico",
						description: "Stylus(.styl) [ http://stylus-lang.com ]"
					},
					{
						name: "styled-components",
						icon: "https://styled-components.com/favicon.png",
						description: "Styled-components [ https://styled-components.com ]"
					},
					{
						name: "@emotion/styled",
						icon: "https://emotion.sh/favicons/favicon.ico",
						description: "Emotion [ https://emotion.sh ]"
					},
					{
						name: "styled-jsx",
						icon: "https://assets.vercel.com/image/upload/q_auto/front/favicon/vercel/favicon.ico",
						description: "Styled-jsx [ https://www.npmjs.com/package/styled-jsx ]"
					}
				]
			}
		},
		{
			name: "--interactive",
			description: "Enable interactive mode when using presets (boolean)",
			args: boolArg("interactive", true)
		},
		{
			name: ["--packageManager", "--pm"],
			description: "Package manager to use (npm, yarn, pnpm)",
			args: {
				name: "packageManager",
				suggestions: [
					{
						name: "npm",
						icon: "fig://icon?type=npm"
					},
					{
						name: "yarn",
						icon: "fig://icon?type=yarn"
					},
					{
						name: "pnpm",
						icon: "https://pnpm.io/img/favicon.png"
					}
				]
			}
		},
		{
			name: "--nx-cloud",
			description: "Use Nx Cloud (boolean)",
			args: boolArg("nx-cloud", true)
		},
		{
			name: ["--help", "-h"],
			description: "Show help for create-nx-workspace"
		}
	],
	args: workspaceNameArg
};
//#endregion
export { completionSpec as default };
