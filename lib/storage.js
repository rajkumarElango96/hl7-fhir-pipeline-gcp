const { Storage }     = require('@google-cloud/storage')
const { GCP_PROJECT } = require('../config')

const storage = new Storage({ projectId: GCP_PROJECT })

async function readTextGcs(bucketName, fileName) {
  const [contents] = await storage.bucket(bucketName).file(fileName).download()
  return contents.toString('utf8')
}

module.exports = { readTextGcs }
