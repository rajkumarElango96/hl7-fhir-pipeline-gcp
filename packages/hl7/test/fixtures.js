// Synthetic test messages. All identifiers and people are made up.
export const A01 = [
  'MSH|^~\\&|HIS|APOLLO-SYN|PIPELINE|PIPELINE|20261020103000||ADT^A01^ADT_A01|MSG0001|P|2.5',
  'EVN|A01|20261020103000',
  'PID|1||MRN100001^^^APOLLO-SYN^MR~12-3456-7890-1234^^^ABDM^ABHA||Sharma^Priya||19900215|F|||12 Anna Salai^^Chennai^Tamil Nadu^600002^IN||+919812345678',
  'PV1|1|I|WARD3^R12^B2||||D123^Iyer^Anil||||||||||||V9001|||||||||||||||||||||||||20261020102500',
].join('\r');

// Discharge two days later (HL7 2.5 uses the ADT_A03 structure for A03).
export const A03 = A01
  .replace('20261020103000||ADT^A01^ADT_A01|MSG0001', '20261022090000||ADT^A03^ADT_A03|MSG0002')
  .replace('EVN|A01|20261020103000', 'EVN|A03|20261022090000')
  .replace(/20261020102500$/, '20261020102500|20261022090000');

// Demographics update between admit and discharge. ADT_A01 structure, so PV1 is still present.
export const A08 = A01
  .replace('20261020103000||ADT^A01^ADT_A01|MSG0001', '20261021120000||ADT^A08^ADT_A01|MSG0003')
  .replace('EVN|A01|20261020103000', 'EVN|A08|20261021120000')
  .replace('+919812345678', '+919800000000');

// Issue 3 from the manual run: an A08 without a PV1 segment.
export const A08_WITHOUT_PV1 = A08.split('\r').filter((s) => !s.startsWith('PV1')).join('\r');

export const A01_MISSING_VISIT = A01.replace('|V9001|', '||');

export const A01_WITHOUT_PID = A01.split('\r').filter((s) => !s.startsWith('PID')).join('\r');
