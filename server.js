//Server NodeJS script for hosting an isolated game server
//To test, install NodeJS and run 'node server.js'

//This script can also be directly uploaded to a Node equipped server for easy deployment!
//Make sure to include the package.json and package-lock.json files

const serverNet = Object.freeze( //Enum for server-to-client packets
	{
		"assign": 1,
		"message": 2,
		"miscData": 3,
		"pos": 4,
		"myRoom": 5,
		"outfit": 6,
		"name": 7,
		"leave": 8,
		"playerObj": 9,

		"heartbeat": 10
	});

const clientNet = Object.freeze( //Enum for client-to-server packets
	{
		"ID": 20,

		"pos": 21,
		"myRoom": 22,
		"outfit": 23,
		"name": 24,

		"message": 25,
		"email": 26,
		"upload": 27,
		"miscData": 28,

		"heartbeat": 29
	});

const clusterNet = Object.freeze( //Enum for cluster packets
	{
		"count": 40,
		"playerData": 41,
		"miscData": 42,
		"type": 43,
		"serverData": 44,
		"queue": 45,
		"leave": 46
	});

let serverIndex = 0; //Server index within a larger cluster
let playerCount = 0; //Number of connected players

//NPM Imports
const net = require("net");
const http = require("http");
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

//OPTIONAL - Firebase Realtime Database connection
const fbPath = "./exampleProject-firebase-adminsdk-blah-blahblahblah.json"; //Path to Firebase auth key
try {
	let admin = require("firebase-admin");
	let serviceAccount = require(fbPath);
	const fbURL = "https://exampleProject.firebaseio.com"; //Database URL
	admin.initializeApp({
		credential: admin.credential.cert(serviceAccount),
		databaseURL: fbURL
	});
	const db = admin.database();
	const ref = db.ref();
}
catch (e) {
	console.log("Firebase auth is not configured");
}

//OPTIONAL - Email support
try {
	const nodemailer = require('nodemailer');
	const transporter = nodemailer.createTransport({
		service: 'gmail', //Email provider
		auth: {
			user: 'username', //Account username
			pass: 'password' //Account password
		}
	});
}
catch (e) {
	console.log("Nodemailer is not configured")
}

//Default webserver setup for handling HTTP requests to the server
//Necessary for AWS Elastic Beanstlak to pass health checks
try {
	http.createServer(function (req, res) {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.write('Ok');
		res.end();
	}).listen(8081);
}
catch (e) {
	console.log("Port in use");
}


let idToSocket = {}; //Object mapping numeric ID to a socket.
let socketToData = {} //Object mapping Socket UIDs to data
const buf = Buffer.alloc(512); //Standard data buffer
const bufLarge = Buffer.alloc(4096); //Large data buffer for JSON data

const tcpPort = 63456; //TCP Port
//WS port is always 1 more than TCP port
let unifiedCluster = false; //Whether the server is co-hosting as part of a cluster

//Function for initializing server
function createServer(serverSocket) {

	//Create TCP server
	const tcpServer = net.createServer()
	tcpServer.on("connection", function (socket) //Player connects
	{
		serverCode(socket, false, socket.remoteAddress.substring(7, socket.remoteAddress.length), serverSocket);

		socket.on("error", function (err) { //Disconnect due to error
			playerDisconnect(socket, serverSocket);
		});
		socket.on("close", function (err) { //Disconnect
			playerDisconnect(socket, serverSocket);
		});
	});
	tcpServer.listen(tcpPort, function () { //Start TCP server
		console.log("The Server has Started");
	});

	//Create WS server
	const wsServer = new WebSocket.Server({ port: tcpPort + 1 });
	wsServer.on('connection', function (ws, req) { //Player connects
		serverCode(ws, true, req.socket.remoteAddress.substring(7, req.socket.remoteAddress.length), serverSocket);

		ws.on('close', function close() { //Disconnect
			playerDisconnect(ws, serverSocket);
		});
	});
}

//Player connection code
function serverCode(socket, isWS, addr, serverSocket) {
	socket.isWS = isWS;
	socket.uid = uuidv4(); //Asign UID to socket variable
	socket.id = playerCount + serverIndex * 256; //Assign sequential ID (16bits) for packet identification. Including the serverIndex guarantees unique IDs across different servers inside a cluster
	playerCount = ((playerCount + 1) % 256); //Iterate ID
	idToSocket[socket.id] = socket; //Add socket to object
	console.log("New player: " + addr);
	console.log("Current number of Players: " + Object.keys(idToSocket).length);

	buf.fill(0); //Reset a buffer before sending it
	buf.writeUInt8(serverNet.assign, 0); //Packet header
	buf.writeUInt16LE(socket.id, 1); //Write ID to buffer
	buf.write(socket.uid, 3); //Write UID to buffer
	writeToSocket(socket, buf); //Send buffer

	if (serverSocket != -1) { //Send the updated player count to the cluster
		buf.fill(0);
		buf.writeUInt8(clusterNet.count, 0);
		buf.writeUInt8(Object.keys(idToSocket).length, 1);
		writeToSocket(serverSocket, buf);
	}

	let _dataName = "data"; //set data type (different between WS and TCP)
	if (isWS) _dataName = "message";
	socket.on(_dataName, function (data) { processPacket(socket, data, serverSocket) }); //Recieving data from the player
}

function processPacket(socket, data, serverSocket) { //Code to process packet data
	const _totalLen = Buffer.byteLength(data);
	let _offset = 0;
	let _end = 0;
	while (_offset < _totalLen) {
		_end = _offset + data.readInt16LE(_offset);
		switch (data.readUInt8(2 + _offset)) { //Check possible headers
			case clientNet.ID: {//Confirming UID
				let _str = readBufString(data, 3 + _offset, _end); //Sanitize buffer string (remove hidden characters/GMS packet identifiers)
				let _data = JSON.parse(_str);
				while (_data.uid in socketToData) _data.uid += "f"; //If two+ clients are created on the same computer at the same time, this stops collisions (good for testing)
				socket.uid = _data.uid; //Set UID
				socketToData[socket.uid] = _data; //Store data

				bufLarge.fill(0); //Send the connection to every other player
				bufLarge.writeUInt8(serverNet.playerObj, 0);
				bufLarge.writeUInt8(socket.id, 1);
				bufLarge.write(_str, 2);
				Object.values(idToSocket).forEach(_sock => {
					if (_sock.id != socket.id) writeToSocket(_sock, bufLarge);
				});

				Object.values(idToSocket).forEach(_sock => { //Send other players to this player
					if (_sock.id != socket.id) {
						bufLarge.fill(0);
						bufLarge.writeUInt8(serverNet.playerObj, 0);
						bufLarge.writeUInt8(_sock.id, 1);
						bufLarge.write(JSON.stringify(socketToData[_sock.uid]), 2);
						writeToSocket(socket, bufLarge);
					}
				});
				break;
			}

			case clientNet.message: { //Recieving chat message
				let _text = readBufString(data, 3 + _offset, _end);
				Object.values(idToSocket).forEach(_sock => {
					if (_sock.id != socket.id) {
						bufLarge.fill(0);
						bufLarge.writeUInt8(serverNet.message, 0); //Message header
						bufLarge.write(_text, 1); //Message contents
						writeToSocket(_sock, bufLarge);
					}
				});
				break;
			}

			case clientNet.email: { //Sending email
				//Example: player submits a bug report
				let _text = readBufString(data, 3 + _offset, _end);
				let mailOptions = { //Nodemailer object
					from: 'exampleSender@gmail.com',
					to: 'helpDesk@gmail.com',
					//cc: 'otherPerson@gmail.com',
					subject: 'Bug Report - Player ' + socketToName[socket.id] + " #" + socket.uid,
					text: 'Bug report:\n\n' + _text
				};

				transporter.sendMail(mailOptions, function (error, info) { //Send email asyncronously
					if (error) {
						console.log(error);
					} else {
						console.log('Email sent: ' + info.response);
					}
				});
				break;
			}

			case clientNet.upload: { //Upload data to Firebase
				//Example: player likes a photo submitted by another player
				const _photoObj = JSON.parse(readBufString(data, 3 + _offset, _end)); //ID stored in JSON
				ref.child("photos/" + _photoObj.ID).once("value").then(function (snapshot) { //Retrive copy of current Firebase entry for that photo
					const _num = snapshot.toJSON() + 1; //Get the number of likes + 1
					ref.child("photos/" + _photoObj.ID).update({ "likes": _num }); //Update the Firebase entry
				});
				break;
			}

			case clientNet.miscData: { //event data send by player
				var _data = JSON.parse(readBufString(data, 3 + _offset, _end));
				break;
			}

			case clusterNet.leave: { //Player disconnecting
				if (!isWS) socket.destroy();
				else socket.close();

				if (unifiedCluster) { //Forward to the cluster if nodes are acting as a unified instance
					writeToSocket(serverSocket, data);
				}
				break;
			}

			case clientNet.heartbeat: { //Recieving a heartbeat
				buf.fill(0);
				buf.writeUInt8(serverNet.heartbeat, 0);
				writeToSocket(socket, buf);
				break;
			}

			default: { forwardPlayerData(data, socket, 2 + _offset, serverSocket, _end); }
		}
		_offset = _end;
	}
}

//OPTIONAL - connect this server to a parent server
//Useful if this server needs to get data from another server or for loadbalancing traffic across a cluster of nodes
const ipToConnect = "127.0.0.1";
const nodes = {}; //Object of all connected nodes in a cluster - only used if part of a unified cluster
if (ipToConnect != "-1") {
	const serverSocket = new net.Socket();
	const serverPort = 63458;
	socket = serverSocket.connect(serverPort, ipToConnect, function () { //Connect to parent server
		console.log("Connected to ServerManager " + ipToConnect);
		socket.isWS = false;
		socket.id = -1;
		socket.uid = "";
		createServer(socket); //Create the server, passing the parent server as an argument in case it needs to be referenced

		socket.on("data", function (data) //Recieving data from the cluster
		{
			let _len = Buffer.byteLength(data);
			switch (data.readUInt8(0)) {
				case clusterNet.miscData: {
					let _data = JSON.parse(readBufString(data, 1, _len));
					break;
				}

				case clusterNet.type: {
					if (data.readUInt8(1) == 1) unifiedCluster = true; //Update the cluster mode

					buf.fill(0);
					buf.writeUInt8(clusterNet.type, 0);
					buf.writeUInt8(1, 1); //1 represents a server
					buf.writeUInt16LE(tcpPort, 1);
					writeToSocket(serverSocket, buf);
					break;
				}

				case clusterNet.serverData: {
					nodes = JSON.parse(readBufString(data, 1, _len));
					break;
				}

				default: { processPacket(socket, data, -1); } //Data coming from another node in a cluster
			}
		});
	});
}
else createServer(-1); //Create the server, passing -1 since there is no parent server



//Helper functions
function writeToSocket(socket, dataBuf) { //Send a buffer to a socket - necessary since WS and TCP use different syntax
	try {
		if (!socket.isWS) {
			socket.write(dataBuf);
		}
		else socket.send(dataBuf);
	}
	catch (err) {
		console.log("Sending error: " + err);
	}
}

function forwardPlayerData(data, socket, dataOffset, serverSocket, end) {
	let _data = -1;
	if (data.readUInt8(dataOffset) == clientNet.message) { //Recieve a message
		_data = readBufString(data, 1 + dataOffset, end);
	}
	else if (data.readUInt8(dataOffset) == clientNet.pos) { //Update position
		_data = [data.readInt16LE(1 + dataOffset), data.readInt16LE(3 + dataOffset), data.readUInt8(5 + dataOffset)];
		socketToData[socket.uid].pos = _data;
	}
	else {
		_data = readBufString(data, 1 + dataOffset, end);
		if (data.readUInt8(dataOffset) == clientNet.myRoom) socketToData[socket.uid].myRoom = _data; //Update room
		else if (data.readUInt8(dataOffset) == clientNet.name) socketToData[socket.uid].name = _data; //Update name
		else if (data.readUInt8(dataOffset) == clientNet.outfit) socketToData[socket.uid].outfit = _data; //Update outfit
	}
	Object.values(idToSocket).forEach(_sock => { //Send update to other players
		if (_sock.id != socket.id) sendPlayerData(data.readUInt8(dataOffset), _data, socket.id, _sock);
	});
	if (unifiedCluster && serverSocket != -1) sendPlayerData(data.readUInt8(dataOffset), _data, socket.id, serverSocket);
}

function playerDisconnect(socket, serverSocket) { //Player disconnects
	delete idToSocket[socket.id];
	Object.values(idToSocket).forEach(_sock => { //Send the disconnect to every other player
		buf.fill(0);
		buf.writeUInt8(serverNet.leave, 0);
		buf.writeUInt16LE(socket.id, 1);
		writeToSocket(_sock, buf);
	});

	if (serverSocket != -1) { //Send the disconnect to the cluster
		buf.fill(0);
		buf.writeUInt8(serverNet.leave, 0);
		buf.writeUInt16LE(socket.id, 1);
		writeToSocket(serverSocket, buf);
	}

	delete socketToData[socket.uid];
	console.log("Remaining Players: " + Object.keys(idToSocket).length);
}

function sendPlayerData(_type, _data, _fromSocketID, _toSocket) {//Send player data from one socket to another socket
	buf.fill(0);
	buf.writeUInt8(_type, 0);
	buf.writeUInt16LE(_fromSocketID, 1);
	if ((typeof _data) == "string") buf.write(_data, 3); //Write string data
	else { //Arry of positions
		buf.writeInt16LE(_data[0], 3);
		buf.writeInt16LE(_data[1], 5);
		buf.writeUInt8(_data[2], 7)
	}
	writeToSocket(_toSocket, buf);
}

function readBufString(str, ind, end) { //Sanitize a string to remove GMS headers and characters
	return str.toString("utf-8", ind, end).replace(/\0/g, '').replace("\u0005", "");
}