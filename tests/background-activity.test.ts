import test from 'node:test';
import assert from 'node:assert/strict';
import {backgroundActivities,startBackgroundActivity,dismissBackgroundActivity} from '../src/ui/background-activity.ts';
test('concurrent background jobs keep independent progress and completion links',()=>{
 backgroundActivities.value=[];let opened='';
 const billing=startBackgroundActivity('Billing report…','billing',()=>{opened='generated';});
 const backup=startBackgroundActivity('Creating backup…','data');
 billing.update('2 of 5 days checked');
 assert.equal(backgroundActivities.value.length,2);
 assert.equal(backgroundActivities.value[0]?.detail,'2 of 5 days checked');
 backup.finish('Backup ready');
 assert.equal(backgroundActivities.value[0]?.done,false);
 billing.finish('Billing report ready');billing.update('late progress');assert.equal(backgroundActivities.value[0]?.detail,'');backgroundActivities.value[0]?.reveal?.();assert.equal(opened,'generated');
 dismissBackgroundActivity(backgroundActivities.value[1]!.id);assert.equal(backgroundActivities.value.length,1);
 const next=startBackgroundActivity('Exporting…','billing');
 assert.equal(backgroundActivities.value.length,1);assert.equal(backgroundActivities.value[0]?.done,false);
 billing.finish();assert.equal(backgroundActivities.value.length,1);
 next.finish();assert.equal(backgroundActivities.value.length,0);
});
