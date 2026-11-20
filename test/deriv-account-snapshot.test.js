import test from "node:test";
import assert from "node:assert/strict";
import {
 normalizeDerivBalanceResponse, normalizeDerivPortfolioResponse,
 normalizeDerivOpenContractValuation, buildDerivAccountSnapshot
} from "../lib/deriv/account-snapshot.js";

const accountId="VRTC12345";
const now=1_800_000_000_000;
const at=new Date(now).toISOString();
const balancePayload={msg_type:"balance",balance:{loginid:accountId,balance:10000,currency:"USD",time:now/1000}};
const portfolioPayload={msg_type:"portfolio",portfolio:{contracts:[{
 contract_id:123456,underlying_symbol:"frxEURUSD",contract_type:"CALL",currency:"USD",
 buy_price:10,payout:18,purchase_time:now/1000,expiry_time:now/1000+60
}]}};

const valuationPayload={msg_type:"proposal_open_contract",proposal_open_contract:{
 contract_id:123456,status:"open",currency:"USD",buy_price:"10",bid_price:"12",
 profit:"2",current_spot_time:now/1000
}};

test("normalizes authenticated balance only for exact account and valid currency",()=>{
 const b=normalizeDerivBalanceResponse(balancePayload,accountId,at);
 assert.equal(b.ok,true);
 assert.equal(b.accountId,accountId);
 assert.equal(b.balance,10000);
 assert.equal(b.currency,"USD");
 assert.equal(normalizeDerivBalanceResponse(balancePayload,"VRTC99999",at).ok,false);
 assert.equal(normalizeDerivBalanceResponse({...balancePayload,msg_type:"portfolio"},accountId,at).ok,false);
 assert.equal(normalizeDerivBalanceResponse({msg_type:"balance",balance:{account_id:accountId,balance:1,currency:"USD"}},accountId,at).ok,false);
 assert.equal(normalizeDerivBalanceResponse({msg_type:"balance",balance:{loginid:accountId,balance:-1,currency:"USD"}},accountId,at).ok,false);
 assert.equal(normalizeDerivBalanceResponse({msg_type:"balance",balance:{loginid:accountId,balance:5,currency:"US"}},accountId,at).ok,false);
});

test("normalizes open portfolio contracts and rejects malformed or duplicate entries",()=>{
 const p=normalizeDerivPortfolioResponse(portfolioPayload,accountId,at);
 assert.equal(p.ok,true);
 assert.equal(p.openContractCount,1);
 assert.equal(p.contracts[0].symbol,"frxEURUSD");
 assert.equal("profit" in p.contracts[0],false);
 assert.equal(normalizeDerivOpenContractValuation({...valuationPayload,proposal_open_contract:{...valuationPayload.proposal_open_contract,current_spot_time:now/1000-31}},123456,{now}).reason,"OPEN_CONTRACT_VALUATION_STALE");
 assert.equal(normalizeDerivOpenContractValuation({...valuationPayload,proposal_open_contract:{...valuationPayload.proposal_open_contract,contract_id:123}},123456,{now}).ok,false);
 assert.equal(normalizeDerivPortfolioResponse({msg_type:"balance",portfolio:{contracts:[]}},accountId,at).ok,false);
 assert.equal(normalizeDerivPortfolioResponse({msg_type:"portfolio",portfolio:{contracts:[{contract_id:1}]}},accountId,at).ok,false);
 assert.equal(normalizeDerivPortfolioResponse({msg_type:"portfolio",portfolio:{contracts:[portfolioPayload.portfolio.contracts[0],portfolioPayload.portfolio.contracts[0]]}},accountId,at).ok,false);
});

test("combines only fresh same-account same-currency DEMO account snapshots",()=>{
 const b=normalizeDerivBalanceResponse(balancePayload,accountId,at);
 const p=normalizeDerivPortfolioResponse(portfolioPayload,accountId,at);
 const valuation=normalizeDerivOpenContractValuation(valuationPayload,123456,{now});
 assert.equal(valuation.ok,true);
 assert.equal(valuation.profit,2);
 const result=buildDerivAccountSnapshot({balance:b,portfolio:p,valuations:[valuation],expectedAccountId:accountId,now});
 assert.equal(result.ok,true);
 assert.equal(result.accountMode,"DEMO");
 assert.equal(result.realExecutionAuthorized,false);
 assert.equal(buildDerivAccountSnapshot({balance:{...b,ok:false},portfolio:p,valuations:[valuation],expectedAccountId:accountId,now}).ok,false);
 assert.equal(buildDerivAccountSnapshot({balance:b,portfolio:p,valuations:[valuation],expectedAccountId:"VRTC99999",now}).ok,false);
 assert.equal(buildDerivAccountSnapshot({balance:b,portfolio:p,valuations:[valuation],expectedAccountId:accountId,now:now+16000}).reason,"ACCOUNT_SNAPSHOT_STALE");
 const wrongCurrency=normalizeDerivPortfolioResponse({msg_type:"portfolio",portfolio:{contracts:[{...portfolioPayload.portfolio.contracts[0],currency:"EUR"}]}},accountId,at);
 assert.equal(buildDerivAccountSnapshot({balance:b,portfolio:wrongCurrency,valuations:[valuation],expectedAccountId:accountId,now}).reason,"PORTFOLIO_CURRENCY_MISMATCH");
});
