import _ = require("lodash");
import * as path from 'path';
import request = require("request-promise-native");
import * as zlib from 'zlib';

import { getLocal, Mockttp } from "../../..";
import { expect, nodeOnly } from "../../test-utils";

const INITIAL_ENV = _.cloneDeep(process.env);

nodeOnly(() => {
    describe("Mockttp when used as a transforming proxy", function () {

        let server: Mockttp;
        const remoteServer = getLocal();

        beforeEach(async () => {
            await remoteServer.start();
        });

        afterEach(async () => {
            await server.stop();
            await remoteServer.stop();
            process.env = INITIAL_ENV;
        });

        describe("that forwards requests to a different location", () => {

            beforeEach(async () => {
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);

                expect(remoteServer.port).to.not.equal(server.port);
            });

            it("forwards to the location specified", async () => {
                await remoteServer.forGet('/').thenReply(200, "forwarded response");
                await server.forAnyRequest().thenForwardTo(remoteServer.url);

                const response = await request.get(server.urlFor("/"));

                expect(response).to.equal('forwarded response');
            });

            it("forwards to the location even if the port & protocol is implicit", async () => {
                await remoteServer.forGet('/').thenReply(200, "forwarded response");
                await server.forAnyRequest().thenForwardTo('example.com');

                const response = await request.get(server.urlFor("/"));

                expect(response).to.include('Example Domain');
            });

            it("uses the path portion from the original request url", async () => {
                const remoteEndpointMock = await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url);

                await request.get(server.urlFor("/get"));

                const seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].path).to.equal("/get");
            });

            it("throws an error if the forwarding URL contains a path", async () => {
                const locationWithPath = 'http://localhost:1234/pathIsNotAllowed';

                await expect(server.forAnyRequest().thenForwardTo(locationWithPath))
                .to.be.rejectedWith(/Did you mean http:\/\/localhost:1234\?$/g);
            });

            it("updates the host header by default", async () => {
                const remoteEndpointMock = await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url);

                await request.get(server.urlFor("/get"));

                const seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal(`localhost:${remoteServer.port}`);
            });

            it("can skip updating the host header if requested", async () => {
                const remoteEndpointMock = await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url, {
                    forwarding: { updateHostHeader: false }
                });

                await request.get(server.urlFor("/get"));

                const seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal(`localhost:${server.port}`);
            });

            it("can update the host header to a custom value if requested", async () => {
                const remoteEndpointMock = await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url, {
                    forwarding: { updateHostHeader: 'google.com' }
                });

                await request.get(server.urlFor("/get"));

                const seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal('google.com');
            });
        });

        describe("that transforms requests automatically", () => {

            beforeEach(async () => {
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);

                // The remote server always echoes our requests
                expect(remoteServer.port).to.not.equal(server.port);
                await remoteServer.forAnyRequest().thenCallback(async (req) => ({
                    status: 200,
                    json: {
                        url: req.url,
                        method: req.method,
                        headers: req.headers,
                        body: await req.body.getText(),
                    }
                }));
            });

            const baseHeaders = () => ({
                'host': `localhost:${remoteServer.port}`,
                'accept': 'application/json',
                'content-type': 'application/json',
                'connection': 'close',
            });

            it("does nothing with an empty transform", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {}
                });

                const response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '7',
                        'custom-header': 'a-value'
                    },
                    body: JSON.stringify({ a: 1 })
                });
            });

            it("can replace the request method", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        replaceMethod: 'PUT'
                    }
                });

                const response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'PUT',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '7',
                        'custom-header': 'a-value'
                    },
                    body: JSON.stringify({ a: 1 })
                });
            });

            it("can add extra headers", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        updateHeaders: {
                            'new-header': 'new-value'
                        }
                    }
                });

                const response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '7',
                        'custom-header': 'a-value',
                        'new-header': 'new-value'
                    },
                    body: JSON.stringify({ a: 1 })
                });
            });

            it("can replace specific headers", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        updateHeaders: {
                            'custom-header': 'replaced-value'
                        }
                    }
                });

                const response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '7',
                        'custom-header': 'replaced-value'
                    },
                    body: JSON.stringify({ a: 1 })
                });
            });

            it("can replace all headers", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        replaceHeaders: {
                            'custom-header': 'replaced-value'
                        }
                    }
                });

                const response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: `http://undefined/abc`, // Because we removed the host header completely
                    method: 'POST',
                    headers: {
                        // Required unavoidable headers:
                        'connection': 'close',
                        'transfer-encoding': 'chunked', // Because we removed content-length
                        // No other headers, only injected value:
                        'custom-header': 'replaced-value'

                    },
                    body: JSON.stringify({ a: 1 })
                });
            });

            it("can replace the body with a string", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        replaceBody: 'replacement-body'
                    }
                });

                const response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '16',
                        'custom-header': 'a-value'
                    },
                    body: 'replacement-body'
                });
            });

            it("can replace the body with a buffer", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        replaceBody: Buffer.from('replacement buffer', 'utf8')
                    }
                });

                const response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '18',
                        'custom-header': 'a-value'
                    },
                    body: 'replacement buffer'
                });
            });

            it("can replace the body with a file", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        updateHeaders: {
                            "content-type": 'text/plain'
                        },
                        replaceBodyFromFile:
                            path.join(__dirname, '..', '..', 'fixtures', 'response-file.txt')
                    }
                });

                const response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-type': 'text/plain',
                        'content-length': '23',
                        'custom-header': 'a-value'
                    },
                    body: 'Response from text file'
                });
            });

            it("should show a clear error when replacing the body with a non-existent file", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        replaceBodyFromFile:
                            path.join(__dirname, 'non-existent-file.txt')
                    }
                });

                await expect(request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                })).to.be.rejectedWith('no such file or directory');
            });

            it("can update a JSON body with new fields", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        updateJsonBody:{
                            a: 100, // Update
                            b: undefined, // Remove
                            c: 2 // Add
                        }
                    }
                });

                const response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1, b: 2 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '15',
                        'custom-header': 'a-value'
                    },
                    body: JSON.stringify({ a: 100, c: 2 })
                });
            });

            it("can update a JSON body while handling encoding automatically", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        updateJsonBody:{
                            a: 100, // Update
                            b: undefined, // Remove
                            c: 2 // Add
                        }
                    }
                });

                const rawResponse = await request.post(remoteServer.urlFor("/abc"), {
                    headers: {
                        'accept': 'application/json',
                        'content-type': 'application/json',
                        'content-encoding': 'gzip',
                        'custom-header': 'a-value'
                    },
                    body: zlib.gzipSync(
                        JSON.stringify({ a: 1, b: 2 })
                    )
                });

                const response = JSON.parse(rawResponse);
                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-encoding': 'gzip',
                        'content-length': '35',
                        'custom-header': 'a-value'
                    },
                    body: JSON.stringify({ a: 100, c: 2 })
                });
            });
        });

        describe("that transforms responses automatically", () => {

            beforeEach(async () => {
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);

                // The remote server always returns a fixed value
                expect(remoteServer.port).to.not.equal(server.port);
                await remoteServer.forAnyRequest().thenJson(200, {
                    'body-value': true,
                    'another-body-value': 'a value',
                }, {
                    'custom-response-header': 'custom-value'
                });
            });

            it("does nothing with an empty transform", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {}
                });

                const response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '50',
                    'custom-response-header': 'custom-value'
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': true,
                    'another-body-value': 'a value',
                });
            });

            it("can replace the response status", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        replaceStatus: 404
                    }
                });

                const response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(404);
                expect(response.statusMessage).to.equal('Not Found');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '50',
                    'custom-response-header': 'custom-value'
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': true,
                    'another-body-value': 'a value',
                });
            });

            it("can add extra headers", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        updateHeaders: {
                            'new-header': 'new-value'
                        }
                    }
                });

                const response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '50',
                    'custom-response-header': 'custom-value',
                    'new-header': 'new-value'
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': true,
                    'another-body-value': 'a value',
                });
            });

            it("can replace specific headers", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        updateHeaders: {
                            'custom-response-header': 'replaced-value'
                        }
                    }
                });

                const response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '50',
                    'custom-response-header': 'replaced-value',
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': true,
                    'another-body-value': 'a value',
                });
            });

            it("can replace all headers", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        replaceHeaders: {
                            'custom-replacement-header': 'replaced-value'
                        }
                    }
                });

                const response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'custom-replacement-header': 'replaced-value'
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': true,
                    'another-body-value': 'a value',
                });
            });

            it("can replace the body with a string", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        replaceBody: 'replacement-body'
                    }
                });

                const response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '16',
                    'custom-response-header': 'custom-value',
                });
                expect(response.body).to.equal('replacement-body');
            });

            it("can replace the body with a buffer", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        replaceBody: Buffer.from('replacement buffer', 'utf8')
                    }
                });

                const response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '18',
                    'custom-response-header': 'custom-value',
                });
                expect(response.body).to.equal('replacement buffer');
            });

            it("can replace the body with a file", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        updateHeaders: {
                            "content-type": 'text/plain'
                        },
                        replaceBodyFromFile:
                            path.join(__dirname, '..', '..', 'fixtures', 'response-file.txt')
                    }
                });

                const response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'text/plain',
                    'content-length': '23',
                    'custom-response-header': 'custom-value'
                });
                expect(response.body).to.equal('Response from text file');
            });

            it("should show a clear error when replacing the body with a non-existent file", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        replaceBodyFromFile:
                            path.join(__dirname, 'non-existent-file.txt')
                    }
                });

                await expect(request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                })).to.be.rejectedWith('no such file or directory');
            });

            it("can update a JSON body with new fields", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        updateJsonBody:{
                            'body-value': false, // Update
                            'another-body-value': undefined, // Remove
                            'new-value': 123 // Add
                        }
                    }
                });

                const response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '36',
                    'custom-response-header': 'custom-value'
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': false,
                    'new-value': 123
                });
            });

            it("can update a JSON body while handling encoding automatically", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        updateHeaders: {
                            'content-encoding': 'br'
                        },
                        updateJsonBody:{
                            'body-value': false, // Update
                            'another-body-value': undefined, // Remove
                            'new-value': 123 // Add
                        }
                    }
                });

                const response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false,
                    encoding: null
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '40',
                    'custom-response-header': 'custom-value',
                    'content-encoding': 'br'
                });

                expect(
                    JSON.parse(
                        zlib.brotliDecompressSync(
                            response.body
                        ).toString('utf8')
                    )
                ).to.deep.equal({
                    'body-value': false,
                    'new-value': 123
                });
            });

        });
    });
});