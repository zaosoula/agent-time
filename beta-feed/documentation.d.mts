export function documentationPaths():string[];
export function hasDocumentationPage(slug?:string):boolean;
export function renderDocumentation(options:{slug?:string;version?:string|null;installLink?:string|null;publicOrigin?:string}):string;
