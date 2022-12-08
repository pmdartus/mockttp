import * as _ from 'lodash';
import * as http from 'http';
import * as zlib from 'zlib';

import {
    getLocal,
    InitiatedRequest,
    CompletedRequest,
    CompletedResponse,
    Mockttp,
    TimingEvents,
    AbortedRequest
} from "../../..";
import {
    expect,
    fetch,
    nodeOnly,
    isNode,
    getDeferred,
    delay
} from "../../test-utils";

function makeAbortableRequest(server: Mockttp, path: string) {
    if (isNode) {
        const req = http.request({
            method: 'POST',
            hostname: 'localhost',
            port: server.port,
            path
        });
        req.on('error', () => {});
        return req;
    } else {
        const abortController = new AbortController();
        fetch(server.urlFor(path), {
            method: 'POST',
            signal: abortController.signal as AbortSignal
        }).catch(() => {});
        return abortController;
    }
}

describe("Response subscriptions", () => {

    describe("with an HTTP server", () => {

        const server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should notify with response details & body when a response is completed", async () => {
            server.forGet('/mocked-endpoint').thenReply(200, 'Mock response', {
                'x-extra-header': 'present'
            });

            const seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            const seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal('Mock response');
            expect(seenResponse.tags).to.deep.equal([]);

            expect(seenResponse.headers).to.deep.equal(isNode
                ? {
                    'x-extra-header': 'present'
                }
                : {
                    'x-extra-header': 'present',
                    'access-control-allow-origin': '*'
                }
            );
        });

        it("should expose ungzipped bodies as .text", async () => {
            const body = zlib.gzipSync('Mock response');

            server.forGet('/mocked-endpoint').thenReply(200, body, {
                'content-encoding': 'gzip'
            });

            const seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            const seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal('Mock response');
        });

        it("should expose un-deflated bodies as .text", async () => {
            const body = zlib.deflateSync('Mock response');

            server.forGet('/mocked-endpoint').thenReply(200, body, {
                'content-encoding': 'deflate'
            });

            const seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            const seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal('Mock response');
        });

        it("should expose un-raw-deflated bodies as .text", async () => {
            const body = zlib.deflateRawSync('Mock response');

            server.forGet('/mocked-endpoint').thenReply(200, body, {
                'content-encoding': 'deflate'
            });

            const seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            const seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal('Mock response');
        });

        it("should include an id that matches the request event", async () => {
            server.forGet('/mocked-endpoint').thenReply(200);

            const seenRequestPromise = getDeferred<CompletedRequest>();
            const seenResponsePromise = getDeferred<CompletedResponse>();

            await Promise.all([
                server.on('request', (r) => seenRequestPromise.resolve(r)),
                server.on('response', (r) => seenResponsePromise.resolve(r))
            ]);

            fetch(server.urlFor("/mocked-endpoint"));

            const seenResponse = await seenResponsePromise;
            const seenRequest = await seenRequestPromise;

            expect(seenRequest.id).to.be.a('string');
            expect(seenRequest.id).to.equal(seenResponse.id);
        });

        it("should include timing information", async () => {
            const seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

            const { timingEvents } = <{ timingEvents: TimingEvents }> await seenResponsePromise;
            expect(timingEvents.startTimestamp).to.be.a('number');
            expect(timingEvents.bodyReceivedTimestamp).to.be.a('number');
            expect(timingEvents.headersSentTimestamp).to.be.a('number');
            expect(timingEvents.responseSentTimestamp).to.be.a('number');

            expect(timingEvents.bodyReceivedTimestamp).to.be.greaterThan(timingEvents.startTimestamp);
            expect(timingEvents.headersSentTimestamp).to.be.greaterThan(timingEvents.startTimestamp);
            expect(timingEvents.responseSentTimestamp).to.be.greaterThan(timingEvents.headersSentTimestamp!);

            expect(timingEvents.abortedTimestamp).to.equal(undefined);
        });

        it("should include raw header data", async () => {
            await server.forGet('/mocked-endpoint').thenReply(200, undefined, {
                "first-header": "1",
                "UPPERCASE-header": "value",
                "last-header": "2",
            });

            const seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            const seenResponse = await seenResponsePromise;
            expect(seenResponse.rawHeaders).to.deep.equal([
                ...(isNode
                    ? []
                    : [['access-control-allow-origin', '*']]
                ),
                ["first-header", "1"],
                ["UPPERCASE-header", "value"],
                ["last-header", "2"]
            ]);
        });
    });

    describe("with an HTTP server allowing only tiny bodies", () => {

        const server = getLocal({
            maxBodySize: 10 // 10 bytes max
        });

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should include tiny bodies in response events", async () => {
            server.forGet('/mocked-endpoint').thenReply(200, 'TinyResp', {
                'x-extra-header': 'present'
            });

            const seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            const seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal('TinyResp');
        });

        it("should not include the body in the response event", async () => {
            server.forGet('/mocked-endpoint').thenReply(200, 'Large response body', {
                'x-extra-header': 'present'
            });

            const seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            const seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal(''); // Body omitted
        });

    });

    describe("with an HTTPS server", () => {

        const server = getLocal({
            https: {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            }
        });

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should notify with response details & body when a response is completed", async () => {
            server.forGet('/mocked-endpoint').thenReply(200, 'Mock response', {
                'x-extra-header': 'present'
            });

            const seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            const seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal('Mock response');
            expect(seenResponse.tags).to.deep.equal([]);

            const matchableHeaders = _.omit(seenResponse.headers);
            expect(matchableHeaders).to.deep.equal(isNode
                ? {
                    'x-extra-header': 'present'
                }
                : {
                    'x-extra-header': 'present',
                    'access-control-allow-origin': '*'
                }
            );
        });
    });
});

describe("Abort subscriptions", () => {
    const server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should not be sent for successful requests", async () => {
        const seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));
        await server.forGet('/mocked-endpoint').thenReply(200);

        await fetch(server.urlFor("/mocked-endpoint"));

        await expect(Promise.race([
            seenAbortPromise,
            delay(100).then(() => { throw new Error('timeout') })
        ])).to.be.rejectedWith('timeout');
    });

    it("should be sent when a request is aborted whilst handling", async () => {
        const seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        const seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forPost('/mocked-endpoint').thenCallback(() => delay(500).then(() => ({})));

        const abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        const seenRequest = await seenRequestPromise;
        abortable.abort();

        const seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
        expect(seenRequest.tags).to.deep.equal([]);
        expect(seenRequest.headers['host']).to.deep.equal(`localhost:${server.port}`);
        expect(
            seenRequest.rawHeaders.find(([key]) => key === 'Host')
        ).to.deep.equal(['Host', `localhost:${server.port}`]); // Uppercase header name!
        expect(seenAbort.error).to.equal(undefined); // Client abort, not an error
    });

    it("should be sent when a request is aborted during an intentional timeout", async () => {
        const seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        const seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forPost('/mocked-endpoint').thenTimeout();

        const abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        const seenRequest = await seenRequestPromise;
        abortable.abort();

        const seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
        expect(seenAbort.error).to.equal(undefined); // Client abort, not an error
    });

    it("should be sent when a request is intentionally closed by a close handler", async () => {
        const seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        const seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forGet('/mocked-endpoint').thenCloseConnection();

        fetch(server.urlFor('/mocked-endpoint')).catch(() => {});

        const seenRequest = await seenRequestPromise;
        const seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);

        expect(seenAbort.error!.message).to.equal('Connection closed intentionally by rule');
    });

    it("should be sent when a request is intentionally closed by a callback handler", async () => {
        const seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        const seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forGet('/mocked-endpoint').thenCallback(() => 'close');

        fetch(server.urlFor('/mocked-endpoint')).catch(() => {});

        const seenRequest = await seenRequestPromise;
        const seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
        expect(seenAbort.error!.message).to.equal('Connection closed intentionally by rule');
    });

    it("should be sent when a request is intentionally closed by beforeRequest", async () => {
        const seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        const seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forGet('/mocked-endpoint').thenPassThrough({
            beforeRequest: () => ({
                response: 'close'
            })
        });

        fetch(server.urlFor('/mocked-endpoint')).catch(() => {});

        const seenRequest = await seenRequestPromise;
        const seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
        expect(seenAbort.error!.message).to.equal('Connection closed intentionally by rule');
    });

    it("should be sent when a forwarded request is intentionally closed by beforeResponse", async () => {
        const seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        const seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forGet('/mocked-endpoint').thenPassThrough({
            forwarding: { targetHost: 'example.com' },
            beforeResponse: () => 'close'
        });

        fetch(server.urlFor('/mocked-endpoint')).catch(() => {});

        const seenRequest = await seenRequestPromise;
        const seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
        expect(seenAbort.error!.message).to.equal('Connection closed intentionally by rule');
    });

    nodeOnly(() => {
        it("should be sent when a request is aborted before completion", async () => {
            let wasRequestSeen = false;
            await server.on('request', (r) => { wasRequestSeen = true; });

            const seenAbortPromise = getDeferred<AbortedRequest>();
            await server.on('abort', (r) => seenAbortPromise.resolve(r));

            const abortable = makeAbortableRequest(server, '/mocked-endpoint') as http.ClientRequest;
            // Start writing a body, but never .end(), so it never completes
            abortable.write('start request', () => abortable.abort());

            const seenAbort = await seenAbortPromise;
            expect(seenAbort.timingEvents.bodyReceivedTimestamp).to.equal(undefined);
            expect(seenAbort.error).to.equal(undefined); // Client abort, not an error
            expect(wasRequestSeen).to.equal(false);
        });

        describe("given a server that closes connections", () => {

            const badServer = new http.Server((req, res) => {
                // Forcefully close the socket with no response
                req.socket!.destroy();
            });

            beforeEach(async () => {
                await new Promise((resolve, reject) => {
                    badServer.listen(8901);
                    badServer.on('listening', resolve);
                    badServer.on('error', reject);
                });
            });

            afterEach(() => {
                badServer.close();
            });

            it("should be sent when the remote server aborts the response", async () => {
                const seenAbortPromise = getDeferred<AbortedRequest>();
                await server.on('abort', (r) => seenAbortPromise.resolve(r));

                const seenResponsePromise = getDeferred<CompletedResponse>();
                await server.on('response', (r) => seenResponsePromise.resolve(r));

                await server.forAnyRequest().thenForwardTo(`http://localhost:8901`);

                fetch(server.urlFor("/mocked-endpoint")).catch(() => {});

                const seenAbort = await Promise.race([
                    seenAbortPromise,
                    seenResponsePromise.then(() => {
                        throw new Error('Should not fire a response event');
                    })
                ]);

                expect(seenAbort.error!.message).to.equal('Upstream connection error: socket hang up');
                expect(seenAbort.error!.code).to.equal('ECONNRESET');
            });

            it("should be sent when a remote proxy aborts the response", async () => {
                const seenAbortPromise = getDeferred<AbortedRequest>();
                await server.on('abort', (r) => seenAbortPromise.resolve(r));

                const seenResponsePromise = getDeferred<CompletedResponse>();
                await server.on('response', (r) => seenResponsePromise.resolve(r));

                await server.forAnyRequest().thenPassThrough({
                    // Wrong port: this connection will fail
                    proxyConfig: { proxyUrl: `http://localhost:8999` }
                });

                fetch(server.urlFor("/mocked-endpoint")).catch(() => {});

                const seenAbort = await Promise.race([
                    seenAbortPromise,
                    seenResponsePromise.then(() => {
                        throw new Error('Should not fire a response event');
                    })
                ]);

                expect(seenAbort.error!.message).to.be.oneOf([
                    'Upstream connection error: connect ECONNREFUSED 127.0.0.1:8999',
                    'Upstream connection error: connect ECONNREFUSED ::1:8999'
                ]);
                expect(seenAbort.error!.code).to.equal('ECONNREFUSED');
            });
        });
    });

    it("should be sent in place of response notifications, not in addition", async () => {
        const seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        const seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => seenResponsePromise.resolve(r));

        await server.forPost('/mocked-endpoint').thenCallback((req) => delay(500).then(() => ({})));

        const abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        await seenRequestPromise;
        abortable.abort();

        await expect(Promise.race([
            seenResponsePromise,
            delay(100).then(() => { throw new Error('timeout') })
        ])).to.be.rejectedWith('timeout');
    });

    it("should include timing information", async () => {
        const seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        const seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forPost('/mocked-endpoint').thenCallback(() => delay(500).then(() => ({})));

        const abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        await seenRequestPromise;
        abortable.abort();

        const { timingEvents } = <{ timingEvents: TimingEvents }> await seenAbortPromise;
        expect(timingEvents.startTimestamp).to.be.a('number');
        expect(timingEvents.bodyReceivedTimestamp).to.be.a('number');
        expect(timingEvents.abortedTimestamp).to.be.a('number');

        expect(timingEvents.abortedTimestamp).to.be.greaterThan(timingEvents.startTimestamp);

        expect(timingEvents.headersSentTimestamp).to.equal(undefined);
        expect(timingEvents.responseSentTimestamp).to.equal(undefined);
    });
});