import test from "node:test";
import assert from "node:assert/strict";
import { calculateDerivOptionsOpenStakeRisk } from "../lib/deriv/options-portfolio-risk.js";

const base={
 ok:true,accountId:"VRTC12345",accountMode:"DEMO",currency:"USD",balance:1000,
 openContracts:[
  {contractId:11,currency:"USD",buyPrice:25},
  {contractId:12,currency:"USD",buyPrice:15}
 ]
};

test("sums provider-reported open options purchase prices as stake at risk",()=>{
 const result=calculateDerivOptionsOpenStakeRisk(base);
 assert.equal(result.ok,true);
 assert.equal(result.openStakeAtRisk,40);
 assert.equal(result.balanceRatio,0.04);
 assert.equal(result.riskBasis,"SUM_OF_PROVIDER_REPORTED_OPTIONS_BUY_PRICE");
 assert.equal(result.executionAuthorized,false);
});

test("blocks missing, duplicate, negative and currency-mismatched open risk inputs",()=>{
 assert.equal(calculateDerivOptionsOpenStakeRisk({...base,openContracts:[{contractId:11,currency:"USD",buyPrice:-1}]}).status,"BLOCKED");
 assert.equal(calculateDerivOptionsOpenStakeRisk({...base,openContracts:[{contractId:11,currency:"EUR",buyPrice:1}]}).status,"BLOCKED");
 assert.equal(calculateDerivOptionsOpenStakeRisk({...base,openContracts:[base.openContracts[0],base.openContracts[0]]}).status,"BLOCKED");
 assert.equal(calculateDerivOptionsOpenStakeRisk({...base,accountMode:"REAL"}).status,"BLOCKED");
 assert.equal(calculateDerivOptionsOpenStakeRisk({...base,balance:NaN}).status,"BLOCKED");
});

test("does not claim margin or FX/CFD risk and handles zero balance explicitly",()=>{
 const result=calculateDerivOptionsOpenStakeRisk({...base,balance:0});
 assert.equal(result.ok,true);
 assert.equal(result.balanceRatio,null);
 assert.equal("margin" in result,false);
 assert.equal("lots" in result,false);
});
