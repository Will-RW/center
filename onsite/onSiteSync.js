const fastify = require('fastify')({ logger: true });
// OnSite manual trigger
const { main: onSiteSyncJob } = require('./onsite/onSiteSync');

fastify.get('/', async (request, reply) => {
  return { hello: 'world' };
});

// Hit /onsite-sync to run the OnSite job on‑demand
fastify.get('/onsite-sync', async (request, reply) => {
  try {
    await onSiteSyncJob();
    reply.send('OnSite sync complete!');
  } catch (err) {
    console.error('Error in /onsite-sync route:', err);
    reply.code(500).send('Error running OnSite sync');
  }
});

const start = async () => {
  try {
    await fastify.listen({ port: 3000 });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();