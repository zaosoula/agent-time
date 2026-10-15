import type {BrowserSource} from './sources/types.ts';

export function browserProbeArguments(browsers:BrowserSource[],settings:Record<string,boolean|number>):string[]{
 return browsers.filter(source=>settings[source.setting]===true).flatMap(source=>
  ['safari','chrome','brave'].includes(source.id)?['--browser-'+source.id]:
  [`--browser-bundle=${source.bundleId}`,...(source.titleSuffix?[`--browser-suffix=${source.bundleId}|${source.titleSuffix}`]:[])]);
}
