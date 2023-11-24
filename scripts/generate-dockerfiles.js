/*
 * Copyright 2017 balena.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

/* eslint-disable @typescript-eslint/no-var-requires */
const _ = require('lodash');
const fs = require('fs-extra');
const path = require('path');
const contrato = require('@balena/contrato');
const yaml = require('js-yaml');
const { concurrentForEach } = require('./utils');
const { getSdk } = require('balena-sdk');
const requireAll = require('require-all');
/* eslint-enable @typescript-eslint/no-var-requires */

const balena = getSdk({
	apiUrl: 'https://api.balena-cloud.com/',
	dataDirectory: false,
});

const DEST_DIR = path.join(__dirname, '../balena-base-images');
const BLUEPRINT_PATHS = {
	'os-arch': path.join(__dirname, 'blueprints/os-arch.yaml'),
	'os-device': path.join(__dirname, 'blueprints/os-device.yaml'),
	'stack-device': path.join(__dirname, 'blueprints/stack-device.yaml'),
	'stack-arch': path.join(__dirname, 'blueprints/stack-arch.yaml'),
};
const CONTRACTS_PATH = path.join(__dirname, 'contracts/contracts');

// Find and build all contracts from the contracts/ directory
const allContracts = requireAll({
	dirname: CONTRACTS_PATH,
	filter: /.json$/,
	recursive: true,
	resolve: (json) => {
		// We only want to generate dockerfiles for the
		// canonical contracts
		const { aliases, ...obj } = json;
		return contrato.Contract.build(obj);
	},
});

const contracts = _.reduce(
	_.values(allContracts),
	(accumulator, value) => {
		return _.concat(
			accumulator,
			_.flattenDeep(_.map(_.values(value), _.values)),
		);
	},
	[],
);

// Create universe of contracts
const universe = new contrato.Contract({
	type: 'meta.universe',
});
universe.addChildren(contracts);

// Remove `resinos` and `balenaos` OS contract since we don't want it for the base images
const resinosChildren = universe.findChildren(
	contrato.Contract.createMatcher({
		type: 'sw.os',
		slug: 'resinos',
	}),
);

const balenaosChildren = universe.findChildren(
	contrato.Contract.createMatcher({
		type: 'sw.os',
		slug: 'balena-os',
	}),
);

resinosChildren.concat(balenaosChildren).forEach((child) => {
	universe.removeChild(child);
});

// Load arguments
const types = process.argv.slice(2);
if (types.length === 0) {
	console.error(`Usage: ${process.argv[0]} ${process.argv[1]} <types...>`);
	process.exit(1);
}

let blueprints = types;

if (types.indexOf('all') > -1) {
	// Generate dockerfile for all blueprints
	blueprints = Object.keys(BLUEPRINT_PATHS);
}

void (async () => {
	const supportedDeviceTypes = await balena.models.deviceType.getAllSupported({
		$select: ['name', 'slug'],
	});
	// Remove discontinued device types
	const supportedDeviceFilter = {
		type: 'object',
		properties: {
			slug: {
				type: 'string',
				enum: supportedDeviceTypes.map((device) => device.slug),
			},
		},
	};
	await Promise.all(
		blueprints.map(async (type) => {
			if (!BLUEPRINT_PATHS[type]) {
				console.error(
					`Blueprint for this base images type: ${type} is missing!`,
				);
				process.exit(1);
			}

			const query = yaml.load(await fs.readFile(BLUEPRINT_PATHS[type], 'utf8'));

			if (Object.keys(query.selector).includes('hw.device-type')) {
				query.selector['hw.device-type'] = {
					cardinality: query.selector['hw.device-type'],
					filter: supportedDeviceFilter,
				};
			}

			// Execute query
			const result = contrato.query(
				universe,
				query.selector,
				query.output,
				true,
			);

			// Get templates
			const template = query.output.template[0].data;

			// Write output
			let count = 0;
			await concurrentForEach(result, 5, async (context) => {
				const json = context.toJSON();
				const destination = path.join(
					DEST_DIR,
					json.path,
					query.output.filename,
				);

				console.log(`Generating ${json.slug}`);
				await fs.outputFile(
					destination,
					await contrato.buildTemplate(template, context, {
						directory: CONTRACTS_PATH,
					}),
				);

				if (json.children.sw.blob) {
					// Check and copy local blobs to target directory.
					for (const blob of _.values(json.children.sw.blob)) {
						if (blob.assets.bin.url.indexOf('file://') > -1) {
							try {
								const src = path.join(
									__dirname,
									blob.assets.bin.url.replace('file://', ''),
								);
								await fs.copy(
									src,
									path.join(path.dirname(destination), blob.assets.bin.main),
								);
							} catch (err) {
								throw new Error(
									'Error when copying ' +
										blob.assets.bin.name +
										' to ' +
										path.dirname(destination),
								);
							}
						}
					}
				}
				count++;
			});

			console.log(
				`Generated ${count} results out of ${
					universe.getChildren().length
				} contracts`,
			);
			console.log(`Adding generated ${count} contracts back to the universe`);
		}),
	);
})();
