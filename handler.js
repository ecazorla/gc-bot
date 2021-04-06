'use strict';

// aws
const AWS = require('aws-sdk');
AWS.config.update({region: 'eu-west-2'});

// modules
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const fetch = require('node-fetch');
const cheerio = require('cheerio');

// console input
const argv = require('minimist')(process.argv.slice(2));

// controller
const writeInDynamoDb = true;
const sendMessageViaTwilio = true;

// system var
const twilioAccountId = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhone = process.env.TWILIO_ACCOUNT_PHONE;
const receiverPhone = process.env.PERSONAL_PHONE;

const oosPathByRetail = {
	'currys': {
		out: '.product-page .touch .oos',
		in: 'div[data-component="add-to-basket-button-wrapper"]'
	}
}

async function main() {
	// Get products to scrape from DynamoDB
	const productsToScrape = await getProducts();

	// Products available promise array
	const productsAvailablePromises = await getProductsAvailable(productsToScrape);

	// Return product availability
	const productsAvailable = (await Promise.all(productsAvailablePromises)).filter(product => product.available);

	// Send sms via twilio
	if (sendMessageViaTwilio && productsAvailable.length > 0) {
		const twilioClient = require('twilio')(twilioAccountId, twilioAuthToken);
		const bodyMessage = productsAvailable.map(product => {
			return `${product.name} is now available at ${product.shop}: ${product.url}`
		}).join(' \n ');
		
		await twilioClient.messages
			.create({
				body: `\n\n${bodyMessage}`,
				from: twilioPhone,
				to: receiverPhone
			})
			.then(message => console.log(message.sid))
			.catch(error => {
				console.log(`ERROR: ${error.message}`);
				throw error;
			});
	}

	// Update DynamoDB: flag already notified products
	if (writeInDynamoDb) {
		for (let index = 0; index < productsAvailable.length; index++) {
			const product = productsAvailable[index];
			await updateProduct(product.id);
		}
	}

	return productsAvailable;
}

async function getProducts() {
	const params = {
		TableName: 'gc-bot-products',
		FilterExpression : 'active = :active',
  		ExpressionAttributeValues : {':active' : true}
	};

	const getProductsResult = dynamoDB
		.scan(params)
		.promise()
		.then(res => res.Items)
		.catch(err => err);

	return getProductsResult;
}

async function getProductsAvailable(productsToScrape) {
	return productsToScrape.map(product => {
		return fetch(product.url)
			.then(res => res.text())
			.then(html => {
				const $ = cheerio.load(html);
				const outOfStock = $(oosPathByRetail[product.shop].out);
				const inStock = $(oosPathByRetail[product.shop].in);

				return {
					...product,
					available: outOfStock.length === 0 && inStock.length > 0
				}
			})
	});
}

async function updateProduct(id) {
	const params = {
		TableName: 'gc-bot-products',
		Key: { id : id },
		UpdateExpression: 'set active = :active',
		ExpressionAttributeValues: {
			':active': false
		}
	}

	const updateProductResult = dynamoDB
		.update(params)
		.promise()
		.then(res => {
			return res;
		})
		.catch(err => err)
	
	return updateProductResult;
}

async function scrape(event) {
	const productsAvailable = await main();

	return {
		statusCode: 200,
		body: JSON.stringify(
			{
				message: `${productsAvailable.length} products available`,
				input: event,
			},
			null,
			2
		),
	};
}

// node handler --run -u "url" -s "retailer name"
async function runner() {
	try {
		const mandatoryFields = ['u', 's'];
		mandatoryFields.forEach(field => {
			if (!argv[field]) {
				throw new Error(`Field '${field}' is mandatory`);
			}

			if (field === 's' && !oosPathByRetail[argv[field]]) {
				throw new Error(`Couldn't find shop ${argv[field]}`);
			}
		});

		const productsToScrapeObj = [
			{
				name: 'test',
				shop: argv.s,
				url: argv.u
			}
		]

		const productsAvailablePromises = await getProductsAvailable(productsToScrapeObj);
		const productsAvailable = (await Promise.all(productsAvailablePromises)).filter(product => product.available);

		console.log(productsAvailable);
	} catch (error) {
		console.log(error.message);
	}
}

if (argv.run) {
	runner();
}

module.exports.scrape = scrape;