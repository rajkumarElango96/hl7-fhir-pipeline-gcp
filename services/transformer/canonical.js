// Validated HL7 message -> plain, HL7-free event. Input has already passed validation.
const { get, findMrn, findIdentifier, hl7ToIso } = require('../../lib/hl7')

const SEX = { M: 'male', F: 'female', O: 'other', U: 'unknown' }

function toAdtEvent(msg) {
  const trigger     = get(msg, 'MSH-9.2')
  const messageTime = hl7ToIso(get(msg, 'MSH-7'))

  return {
    eventType:       trigger,
    controlId:       get(msg, 'MSH-10'),
    messageTime,
    sendingFacility: get(msg, 'MSH-4'),
    patient: {
      mrn:       findMrn(msg),
      abha:      findIdentifier(msg, 'ABHA') || undefined,
      family:    get(msg, 'PID-5.1'),
      given:     get(msg, 'PID-5.2') || undefined,
      birthDate: hl7ToIso(get(msg, 'PID-7')),
      gender:    SEX[get(msg, 'PID-8')],
      phone:     get(msg, 'PID-13') || undefined,
      address: {
        line:       get(msg, 'PID-11.1'),
        city:       get(msg, 'PID-11.3'),
        state:      get(msg, 'PID-11.4'),
        postalCode: get(msg, 'PID-11.5'),
        country:    get(msg, 'PID-11.6') || 'IN',
      },
    },
    visit: {
      visitNumber:  get(msg, 'PV1-19'),
      patientClass: get(msg, 'PV1-2'),
      service:      get(msg, 'PV1-10') || undefined,
      location:     [get(msg, 'PV1-3.1'), get(msg, 'PV1-3.2'), get(msg, 'PV1-3.3')].filter(Boolean).join('-'),
      attending: {
        id:   get(msg, 'PV1-7.1'),
        name: [get(msg, 'PV1-7.3'), get(msg, 'PV1-7.2')].filter(Boolean).join(' '),
      },
      // Fall back to the message time when the sender leaves PV1-44 / PV1-45 empty
      admitTime:     hl7ToIso(get(msg, 'PV1-44')) ?? (trigger === 'A01' ? messageTime : undefined),
      dischargeTime: hl7ToIso(get(msg, 'PV1-45')) ?? (trigger === 'A03' ? messageTime : undefined),
    },
  }
}

module.exports = { toAdtEvent }
