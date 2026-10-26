// One JSON line per log entry. Cloud Logging reads `severity` and indexes the other
// fields, so you can filter by service, file or controlId (MSH-10, the correlation ID).
function createLogger(service) {
  const write = (severity, message, fields = {}) =>
    console.log(JSON.stringify({ severity, service, message, ...fields }))

  return {
    info:  (message, fields) => write('INFO', message, fields),
    warn:  (message, fields) => write('WARNING', message, fields),
    error: (message, fields) => write('ERROR', message, fields),
  }
}

module.exports = createLogger
