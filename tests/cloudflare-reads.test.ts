import { expect,test } from 'bun:test';
import { readAll } from '../src/modules/domains/infrastructure/cloudflare';

test('reads overlap up to the limit and keep input order',async()=>{
  let active=0,peak=0;
  const out=await readAll([30,5,20,1,10],async(ms)=>{active++;peak=Math.max(peak,active);await Bun.sleep(ms);active--;return ms*2;},2);
  expect(out).toEqual([60,10,40,2,20]);
  expect(peak).toBe(2);
});

test('the first failure in input order is thrown only after every read settles',async()=>{
  const settled:number[]=[];
  const failure=readAll([1,2,3],async(n)=>{await Bun.sleep(n===1?30:1);settled.push(n);if(n>1)throw new Error(`read ${n}`);return n;},3);
  await expect(failure).rejects.toThrow('read 2');
  expect(settled.sort()).toEqual([1,2,3]);
  expect(await readAll([],async()=>1)).toEqual([]);
});
