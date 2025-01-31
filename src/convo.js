import { get } from 'svelte/store';
import { controller, openaiAPIKey, openrouterAPIKey, params, toolSchema, tools } from './stores.js';
import { providers } from './providers.js';

// OpenAI doesn't provide any metadata for their models, so we have to harddcode which ones are multimodal
export const additionalModelsMultimodal = ['gpt-4o', 'gpt-4-turbo', 'gpt-4-turbo-2024-04-09'];

export function hasCompanyLogo(model) {
	return (
		model &&
		model.provider &&
		(model.provider === 'OpenAI' ||
			model.id.startsWith('openai') ||
			model.id.startsWith('anthropic') ||
			model.id.startsWith('meta-llama') ||
			model.id.startsWith('mistralai') ||
			model.id.startsWith('cohere') ||
			model.provider === 'Groq' ||
			model.id.startsWith('nous') ||
			model.id.startsWith('google') ||
			model.id.startsWith('perplexity'))
	);
}

export function formatModelName(model) {
	let name = model.name;

	// If providers clash, disambiguate provider name
	const disambiguate = get(openaiAPIKey).length > 0 && get(openrouterAPIKey).length > 0;

	if (model.provider === 'OpenAI') {
		name = name
			.split('-')
			.map((word) => {
				if (word.startsWith('gpt')) {
					return word.toUpperCase();
				}
				return word.charAt(0).toUpperCase() + word.slice(1);
			})
			.join(' ');
	}

	if (model.provider === 'Groq') {
		return model.provider + ': ' + name;
	}
	if (disambiguate && model.provider === 'OpenRouter' && name.includes(': ')) {
		return model.provider + ': ' + name.split(': ')[1];
	}
	if (disambiguate) {
		return model.provider + ': ' + name;
	}

	return name;
}

export function conversationToString(convo) {
	let result = '';
	convo.messages.forEach((msg) => {
		result += messageToString(msg, convo.tmpl);
	});
	return result;
}

function conversationStop(convo) {
	switch (convo.tmpl) {
		case 'chatml':
			return ['<|im_end|>', '<|im_start|>', '</tool_call>'];
		case 'deepseek':
			return ['### Instruction:', '### Response:'];
		case 'none':
			return ['</s>'];
		default:
			throw new Error('Unknown template');
	}
}

function messageToString(message, template) {
	switch (template) {
		case 'chatml':
			let s = '<|im_start|>' + message.role + '\n' + message.content;
			if (!message.unclosed) {
				s += '<|im_end|>\n';
			}
			return s;
		case 'deepseek':
			if (message.role === 'system') {
				return message.content + '\n';
			}
			if (message.role === 'user') {
				return '### Instruction:\n' + message.content + '\n';
			}
			if (message.role === 'assistant') {
				return '### Response:\n' + message.content + '\n';
			}
		case 'none':
			return message.content;
	}
}

export async function complete(convo, onupdate, onabort, ondirect) {
	controller.set(new AbortController());

	if (convo.local) {
		const response = await fetch('http://localhost:8080/completion', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			signal: get(controller).signal,
			body: JSON.stringify({
				stream: true,
				prompt: conversationToString(convo),
				stop: conversationStop(convo),
				n_predict: -1,
				repeat_penalty: 1.1,
				cache_prompt: true,
				...(convo.grammar !== '' && { grammar: convo.grammar }),
			}),
		});

		streamResponse(response.body, onupdate, onabort);
	} else {
		const messages = convo.messages.map((msg) => {
			const msgOAI = {
				role: msg.role,
			};

			if (msg.contentParts) {
				msgOAI.content = [
					{
						type: 'text',
						text: msg.content,
					},
					...msg.contentParts,
				];
			} else {
				msgOAI.content = msg.content;
			}

			// Additional data for tool calls
			if (msg.toolcalls) {
				msgOAI.tool_calls = msg.toolcalls.map((t) => {
					return {
						id: t.id,
						type: 'function',
						function: {
							name: t.name,
							arguments: JSON.stringify(t.arguments),
						},
					};
				});
			}
			// Additional data for tool responses
			if (msg.tool_call_id && msg.name) {
				msgOAI.tool_call_id = msg.tool_call_id;
				msgOAI.name = msg.name;
			}

			return msgOAI;
		});

		// TODO: Actually it works with Anthropic also. How to show it as disabled for unsupported?
		// Filter out unclosed messages from being submitted if using external models
		if (
			convo.messages[convo.messages.length - 1].unclosed &&
			convo.messages[convo.messages.length - 1].content === ''
		) {
			messages.pop();
		}

		const schema = get(toolSchema);
		const activeTools = get(tools);
		const activeSchema = schema.filter((tool) => activeTools.includes(tool.function.name));

		const provider = providers.find((p) => p.name === convo.model.provider);

		let stream = true;
		// Groq doesn't support streaming completions with tool calls
		if (provider.name === 'Groq' && activeSchema.length > 0) {
			stream = false;
		}

		const completions = async (signal) => {
			return fetch(`${provider.url}/v1/chat/completions`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${provider.apiKeyFn()}`,
					'HTTP-Referer': 'https://lluminous.chat',
					'X-Title': 'lluminous',
					'Content-Type': 'application/json',
				},
				signal,
				body: JSON.stringify({
					stream,
					model: convo.model.id,
					temperature: get(params).temperature,
					tools: activeSchema.length > 0 ? activeSchema : undefined,
					messages,
				}),
			});
		};

		if (stream) {
			const response = await completions(get(controller).signal);
			streamResponse(response.body, onupdate, onabort);
		} else {
			const response = await completions();
			ondirect(await response.json());
		}
	}
}

async function streamResponse(readableStream, onupdate, onabort) {
	try {
		const reader = readableStream.getReader();
		const decoder = new TextDecoder();

		let done, value;
		let leftover = '';
		while (!done) {
			({ value, done } = await reader.read());

			if (done) {
				return;
			}

			const string = decoder.decode(value);
			const lines = string.split('\n\n');
			for (let line of lines) {
				if (line === '') {
					continue;
				}

				// If we have leftover from the previous chunk, prepend it to the current line
				if (leftover !== '') {
					line = leftover + line;
					leftover = '';
				}

				// Ignore comments
				if (line[0] === ':') {
					continue;
				}

				// OpenAI and only OpenAI sometimes sends "\ndata:"
				line = line.trim();

				if (line.startsWith('data: ')) {
					// Strip "data: " from the start of the url
					const event = line.substring('data: '.length);

					// OpenAI-compatible APIs send "data: [DONE]" at the end of the stream
					if (event === '[DONE]') {
						onabort();
						return;
					}

					try {
						const parsed = JSON.parse(event);
						onupdate(parsed);
					} catch (err) {
						// If the JSON parsing fails, we've got an incomplete event
						leftover = line;
					}
				} else if (line.startsWith('error: ')) {
					console.error('received error event:', line);
					onabort();
					return;
				} else {
					console.log('received unknown event:', string);
					try {
						// If it's a nicely formatted error, display it.
						onupdate({ error: JSON.parse(string).error });
					} catch (_) {
						// Otherwise display whatever unknown event we got.
						onupdate({ error: string });
					}
				}
			}
		}
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') {
			onabort();
		} else {
			console.log(`error.name:`, error.name);
			throw error;
		}
	}
}

export function readFileAsDataURL(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}
