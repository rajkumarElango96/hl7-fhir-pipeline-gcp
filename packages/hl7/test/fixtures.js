// Synthetic test messages. All identifiers and people are made up.
export const A01 = [
  'MSH|^~\\&|HIS|APOLLO-SYN|PIPELINE|PIPELINE|20261020103000||ADT^A01^ADT_A01|MSG0001|P|2.5',
  'EVN|A01|20261020103000',
  'PID|1||MRN100001^^^APOLLO-SYN^MR~12-3456-7890-1234^^^ABDM^ABHA||Sharma^Priya||19900215|F|||12 MG Road^^Bengaluru^Karnataka^560001^IN||+919812345678',
  'PV1|1|I|WARD3^R12^B2||||D123^Iyer^Anil||||||||||||V9001|||||||||||||||||||||||||20261020102500',
].join('\r');

export const A03 = A01
  .replace('ADT^A01^ADT_A01|MSG0001', 'ADT^A03^ADT_A03|MSG0002')
  .replace('EVN|A01', 'EVN|A03')
  .replace(/20261020102500$/, '20261020102500|20261022090000');

export const A08 = A01
  .replace('ADT^A01^ADT_A01|MSG0001', 'ADT^A08^ADT_A01|MSG0003')
  .replace('EVN|A01', 'EVN|A08')
  .replace('+919812345678', '+919800000000');
