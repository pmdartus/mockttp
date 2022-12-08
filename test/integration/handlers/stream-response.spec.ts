import * as semver from 'semver';
import { PassThrough } from 'stream';
import { getLocal } from "../../..";
import { expect, fetch, isNode, delay } from "../../test-utils";

describe("Streaming response handler", function () {

    const server = getLocal({
        cors: isNode
            ? false
            : { exposedHeaders: '*' }
    });

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should allow streaming a response", async () => {
        const stream = new PassThrough();
        await server.forGet('/stream').thenStream(200, stream);

        stream.write('Hello\n');

        const responsePromise = fetch(server.urlFor('/stream'));

        await delay(100);
        stream.write(Buffer.from('world'));

        if (!process.version || semver.major(process.version) >= 8) {
            const arrayBuffer = new Uint8Array(1);
            arrayBuffer[0] = '!'.charCodeAt(0);
            stream.write(arrayBuffer);
        } else {
            // Node < 8 doesn't support streaming array buffers
            stream.write('!');
        }
        stream.end();

        await expect(responsePromise).to.have.status(200);
        await expect(responsePromise).to.have.responseText('Hello\nworld!');
    });

    it("should not allow setting pseudoheaders when streaming a response", async () => {
        const stream = new PassThrough();
        expect(() =>
            server.forGet('/stream').thenStream(200, stream, {
                ':status': '200'
            })
        ).to.throw("Cannot set custom :status pseudoheader values");
    });

    it("should fail clearly when trying to repeat a single stream response", async () => {
        const stream = new PassThrough();
        await server.forGet('/stream').thenStream(200, stream);

        stream.end('Hello world');

        await fetch(server.urlFor('/stream'));
        const responsePromise = await fetch(server.urlFor('/stream'));

        await expect(responsePromise).to.have.status(500);
        expect(await responsePromise.text()).to.include('Stream request handler called more than once');
    });

    it("should allow multiple streaming responses", async () => {
        const stream1 = new PassThrough();
        await server.forGet('/stream').thenStream(200, stream1);
        const stream2 = new PassThrough();
        await server.forGet('/stream').thenStream(200, stream2);

        stream1.end('Hello');
        stream2.end('World');

        const response1 = await fetch(server.urlFor('/stream'));
        const response2 = await fetch(server.urlFor('/stream'));

        await expect(response1).to.have.status(200);
        await expect(response1).to.have.responseText('Hello');
        await expect(response2).to.have.status(200);
        await expect(response2).to.have.responseText('World');
    });

});