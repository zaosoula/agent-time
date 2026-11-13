/** Match actual observed spans; proximity must never select across a gap.
 * Later spans win overlaps, matching the timeline's source paint order. */
export function reviewTimelineHit(spans:ReadonlyArray<{start:number;end:number}>,time:number):number{
  for(let index=spans.length-1;index>=0;index--){const span=spans[index]!;if(time>=span.start&&time<span.end)return index;}
  return -1;
}
