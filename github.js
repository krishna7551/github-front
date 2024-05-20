const { Octokit } = require('@octokit/rest');
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const jwt = require('jsonwebtoken');
require('dotenv').config();


const app = express();
const PORT = process.env.PORT || 3000;

// GitHub App details
const appId = process.env.APP_ID;
const pemPath = process.env.PEM_PATH;
const privateKey = fs.readFileSync(pemPath);

// Front app details
const frontToken = process.env.FRONT_TOKEN;//add front token

let owner = '';
let repo = '';

app.use(express.json());

const processedEvents = new Set();

// Route handler for the root URL
app.get('/', (req, res) => {
    res.send('Welcome to the GitHub Frontend API!');
});

app.post('/github-webhook', async (req, res) => {
    const { action, issue, comment } = req.body;
    const eventId = req.headers['x-github-delivery'];

    if (processedEvents.has(eventId)) {
        return res.status(200).send('Event already processed.');
    }

    processedEvents.add(eventId);

    if (issue) {
        const urlParts = issue.url.split('/');
        owner = urlParts[4];
        repo = urlParts[5];

        if (action === 'opened') {
            try {
                const conversationId= await createFrontConversation(issue);
                await createTagWithLink(issue, issue.number, conversationId);
                res.status(200).send('Conversation created successfully in Frontapp');
            } catch (error) {
                res.status(500).send('Error creating conversation in Frontapp');
            }
        } else if (action === 'created' && comment) {
            try {
                await addCommentToFrontapp(issue.number, comment);
                res.status(200).send('Comment added successfully to Frontapp');
            } catch (error) {
                res.status(500).send('Error adding comment to Frontapp');
            }
        } else {
            res.status(200).send('Webhook received but no action required.');
        }
    } else {
        res.status(400).send('Missing issue details in webhook payload.');
    }
});

app.post('/frontapp-webhook', async (req, res) => {
    const eventId = req.headers['x-front-signature']; 

    if (processedEvents.has(eventId)) {
        return res.status(200).send('Event already processed.');
    }

    processedEvents.add(eventId);

    try {
        const requestBody = req.body;
        const issueNumber = parseIssueNumber(requestBody.subject);
        const commentBody = requestBody.body;
        await addCommentToIssue(owner, repo, issueNumber, commentBody);
        res.status(200).send('Comment added successfully to GitHub issue');
    } catch (error) {
        console.error('Error adding comment to GitHub issue:', error);
        res.status(500).send('Error adding comment to GitHub issue');
    }
});

function parseIssueNumber(subject) {
    const regex = /#(\d+)/;
    const match = subject.match(regex);
    if (match && match[1]) {
        return parseInt(match[1]);
    } else {
        throw new Error('Issue number not found in subject.');
    }
}

async function createFrontConversation(issueDetails) {
    if (!issueDetails) {
        return;
    }

    const { title, number, state, body, html_url } = issueDetails;
    const messageBody = `**GitHub Issue:**\n * Body: ${body}\n `;
    const threadId = number.toString();
    const data = JSON.stringify({
        sender: { name: owner, handle: '123456789' },
        body_format: 'markdown',
        metadata: { headers: { 'threadId': threadId }, thread_ref: threadId },
        attachments: [],
        body: messageBody,
        subject: `#${number} - ${title}`,
    });

    const config = {
        method: 'post',
        url: process.env.URL,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${frontToken}`,
        },
        data,
    };

    try {
        const response = await axios(config);
        console.log('Front Conversation Creation Response:', response.data);
        const messageId = response.data.message_uid;
        console.log('messageId:', messageId);

        const conversationId = await fetchConversationId(messageId);
        console.log('Created Front conversation ID:', conversationId);
        return conversationId;
    } catch (error) {
        throw error;
    }
}

async function fetchConversationId(messageId) {
    const config = {
        method: 'get',
        url: `https://api2.frontapp.com/messages/alt:uid:${messageId}`,
        headers: {
            'Authorization': `Bearer ${frontToken}`,
            'Accept': 'application/json'
        }
    };

    try {
        const response = await axios(config);
        return response.data._links.related.conversation.split('/').pop();
    } catch (error) {
        throw error;
    }
}
async function addCommentToIssue(owner, repo, issueNumber, commentBody) {
    const octokit = await getAuthenticatedOctokit();

    try {
        const payload = {
            owner: owner,
            repo: repo,
            issue_number: issueNumber,
            body: commentBody + '\n\n<!-- GitHub Frontend Bot -->'
        };

        const response = await octokit.issues.createComment(payload);

    } catch (error) {
        console.error('Error adding comment:', error);
        throw error;
    }
}

async function addCommentToFrontapp(issueNumber, comment) {
    const threadId = issueNumber.toString();
    const uniqueIdentifier = '<!-- GitHub Frontend Bot -->';
    if (comment.body.includes(uniqueIdentifier)) {
        return;
    }
    const data = JSON.stringify({
        sender: { name: comment.user.login, handle: comment.user.id.toString() },
        body_format: 'markdown',
        metadata: { headers: { 'threadId': threadId }, thread_ref: threadId },
        attachments: [],
        body: comment.body,
    });

    const config = {
        method: 'post',
        url: process.env.URL,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${frontToken}`,
        },
        data,
    };

    try {
        const response = await axios(config);
    } catch (error) {
        throw error;
    }
}

async function createTagWithLink(issueDetails,issueNumber, conversationId) {
    const {html_url} = issueDetails
    const tag = `github issue-${issueNumber}`;
    const externalUrl = `${html_url}`;

    const data = JSON.stringify({
        name: tag,
        external_url: externalUrl
    });

    const tagCreationUrl = 'https://api2.frontapp.com/links';
    
    try {
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${frontToken}`
            },
            body: data,
        };

        const tagResponse = await fetch(tagCreationUrl, options);

        if (!tagResponse.ok) {
            throw new Error('Failed to create tag link in Frontapp.');
        }

        const responseData = await tagResponse.json();
        const linkId = responseData.id;
        await associateTagLinkWithConversation(conversationId, linkId);

        return linkId;
    } catch (error) {
        throw error;
    }
}

async function associateTagLinkWithConversation(conversationId, linkId) {
    const conversationLinkCreationUrl = `https://api2.frontapp.com/conversations/${conversationId}/links`;

    try {
        const tagLinkResponse = await fetch(conversationLinkCreationUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${frontToken}`
            },
            body: JSON.stringify({
                link_ids: [linkId]
            }),
        });

        if (!tagLinkResponse.ok) {
            throw new Error('Failed to associate tag link with conversation in Frontapp.');
        }

        const responseData = await tagLinkResponse.json(); 

    } catch (error) {
        throw error;
    }
}

async function generateJWT() {
    const payload = {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 540,
        iss: appId
    };

    return jwt.sign(payload, privateKey, { algorithm: 'RS256' });
}

async function getInstallationAccessToken() {
    const jwtToken = await generateJWT();
    const installationId = await getInstallationId();

    const response = await axios.post(`https://api.github.com/app/installations/${installationId}/access_tokens`, {}, {
        headers: {
            Authorization: `Bearer ${jwtToken}`,
            Accept: 'application/vnd.github.v3+json'
        }
    });

    return response.data.token;
}

async function getAuthenticatedOctokit() {
    const accessToken = await getInstallationAccessToken();

    return new Octokit({ auth: accessToken });
}

async function getInstallationId() {
    try {
        const jwtToken = await generateJWT();

        const response = await axios.get('https://api.github.com/app/installations', {
            headers: {
                Authorization: `Bearer ${jwtToken}`,
                Accept: 'application/vnd.github.v3+json'
            }
        });

        const installationId = response.data[0].id;

        return installationId;
    } catch (error) {
        throw error;
    }
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
