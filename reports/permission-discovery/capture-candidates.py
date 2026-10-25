import urllib.request,urllib.error,json,datetime,pathlib,concurrent.futures
base=pathlib.Path(__file__).parent
url='https://hyperliquid.drpc.org'
candidates={'approve-usdc-hyperlend':'0x371bf6c3af982636caa9874bb107a7d3d967cea340678b5dfb856ff35f9923b5','router-permit-candidate':'0x9dba139e63627a8f3693b9a63ff556f89a5358c2603738f6d98172b7ddd3074d'}
def capture(item):
 name,txhash=item;captures={};counter=0
 def call(label,method,params):
  nonlocal counter
  counter+=1;payload={'jsonrpc':'2.0','id':counter,'method':method,'params':params};entry={'request':payload};captures[label]=entry
  try:
   with urllib.request.urlopen(urllib.request.Request(url,data=json.dumps(payload).encode(),headers={'content-type':'application/json'}),timeout=30) as response:entry['httpStatus']=response.status;entry['response']=json.loads(response.read())
   return entry['response'].get('result')
  except urllib.error.HTTPError as error:entry['error']={'kind':'HTTPError','status':error.code}
  except Exception as error:entry['error']={'kind':type(error).__name__}
 chain=call('chainId','eth_chainId',[]);tx=call('transaction','eth_getTransactionByHash',[txhash]);receipt=call('receipt','eth_getTransactionReceipt',[txhash])
 block=call('block','eth_getBlockByHash',[tx['blockHash'],False]) if tx else None
 trace=call('callTrace','debug_traceTransaction',[txhash,{'tracer':'callTracer','timeout':'15s','tracerConfig':{'withLog':True}}])
 diff=call('prestateDiff','debug_traceTransaction',[txhash,{'tracer':'prestateTracer','timeout':'15s','tracerConfig':{'diffMode':True}}])
 confirmed=call('canonicalBlock','eth_getBlockByNumber',[tx['blockNumber'],False]) if tx else None
 checks={'chain999':chain=='0x3e7','transactionHash':bool(tx and tx['hash']==txhash),'receiptHash':bool(receipt and receipt['transactionHash']==txhash),'blockHash':bool(tx and receipt and block and confirmed and len({tx['blockHash'],receipt['blockHash'],block['hash'],confirmed['hash']})==1),'transactionIndex':bool(tx and receipt and tx['transactionIndex']==receipt['transactionIndex']),'successfulReceipt':bool(receipt and receipt['status']=='0x1'),'traceGasMatchesReceipt':bool(trace and receipt and int(trace['gasUsed'],16)==int(receipt['gasUsed'],16)),'traceRootMatches':bool(trace and tx and trace['from'].lower()==tx['from'].lower() and trace['to'].lower()==tx['to'].lower() and trace['input']==tx['input'])}
 document={'retrievedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'observed_public_historical_transaction','rpc':url,'explorerUrl':'https://hyperevmscan.io/tx/'+txhash,'transactionHash':txhash,'checks':checks,'captures':captures,'limitations':['Public historical raw calldata and traces may contain historical signatures. No new signature was obtained and no transaction was broadcast.','Only these two candidate hashes were queried; this is not a chain-wide scan.']}
 (base/(name+'-evidence.json')).write_text(json.dumps(document,indent=2)+'\n')
 permits=[]
 def walk(frame,path='0'):
  if not isinstance(frame,dict):return
  if frame.get('input','').startswith('0xd505accf'):
   data=frame['input'][10:];words=[data[i:i+64] for i in range(0,len(data),64)];permits.append({'path':path,'type':frame.get('type'),'from':frame.get('from'),'to':frame.get('to'),'error':frame.get('error'),'owner':'0x'+words[0][-40:] if len(words)==7 else None,'spender':'0x'+words[1][-40:] if len(words)==7 else None,'valueRaw':str(int(words[2],16)) if len(words)==7 else None})
  for i,child in enumerate(frame.get('calls',[])):walk(child,path+'.'+str(i))
 walk(trace)
 print(json.dumps({'name':name,'hash':txhash,'checks':checks,'block':int(tx['blockNumber'],16) if tx else None,'index':int(tx['transactionIndex'],16) if tx else None,'selector':tx['input'][:10] if tx else None,'permits':permits}))
 return name
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:list(executor.map(capture,candidates.items()))
