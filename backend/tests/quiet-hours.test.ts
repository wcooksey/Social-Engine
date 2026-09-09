import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWithinQuietHours, localHourIn, resolveLeadTimezone } from '../src/utils/timezone';
test('quiet windows include start, exclude end, cross midnight and permit equal hours to disable', () => {
  for (const [hour, quiet] of [[19,false],[20,true],[23,true],[0,true],[7,true],[8,false]]) assert.equal(isWithinQuietHours(20,8,Number(hour)),quiet);
  assert.equal(isWithinQuietHours(9,17,9),true); assert.equal(isWithinQuietHours(9,17,17),false);
  for(let hour=0;hour<24;hour++) assert.equal(isWithinQuietHours(8,8,hour),false);
});
test('lead-local quiet hours use explicit timezone then state then New York', () => {
  assert.equal(resolveLeadTimezone({timezone:'America/Los_Angeles',state:'NY'}),'America/Los_Angeles');
  assert.equal(resolveLeadTimezone({state:'CA'}),'America/Los_Angeles');
  assert.equal(resolveLeadTimezone({}),'America/New_York');
  const instant=new Date('2026-09-10T01:00:00Z');
  assert.equal(isWithinQuietHours(20,8,localHourIn('America/New_York',instant)),true);
  assert.equal(isWithinQuietHours(20,8,localHourIn('America/Los_Angeles',instant)),false);
});
