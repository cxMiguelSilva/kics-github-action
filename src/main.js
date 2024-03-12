const commenter = require("./commenter");
const annotator = require("./annotator");
const core = require("@actions/core");
const github = require("@actions/github");
const io = require("@actions/io");
const filepath = require('path');
const fs = require("fs");
const yaml = require('js-yaml');
const HCL = require("js-hcl-parser")
const toml = require('@iarna/toml');

function readJSON(filename) {
    const rawData = fs.readFileSync(filename);
    return JSON.parse(rawData.toString());
}

function cleanupOutput(resultsJSONFile, outputFormats) {
    if (!outputFormats.toLowerCase().includes('json') || outputFormats === '') {
        io.rmRF(resultsJSONFile);
    }
}

async function processOutputPath(output, configPath, workspace) {
    let resultsFileName = '';
    if (configPath !== '' ) {

        [config_type, content] = await fileAnalyzer(configPath, workspace);
        console.log(`Config type: ${config_type}`);

        if (config_type !== '') {
            console.log(`Config content: ${JSON.stringify(content)}`);
            console.log(`Output path: ${content["output-path"]}`);
            if ( content["output-path"] !== undefined && content["output-path"] !== '' ) {
                const filePath = content["output-path"]
                if (!filePath.startsWith('/') && !filePath.startsWith('./') && !filePath.startsWith('../')) {
                    content["output-path"] =  "/github/workspace" +  content["output-path"];
                }
            }
            output = content["output-path"] || output;
            resultsFileName = content["output-name"] || '';
        }
    }

    if (output === '') {
        return {
            path: "./",
            resultsJSONFile: "./results.json"
        }
    }

    if (resultsFileName === '') {
        resultsFileName = filepath.join(output, "/results.json")
    } else {
        resultsFileName = filepath.join(output, resultsFileName);
    }

    return {
        path: output,
        resultsJSONFile: resultsFileName
    }
}

function readFileContent(filePath, workspace) {
    try {
        // read file content
        console.log(`Reading file: ${filePath}`);
        console.log(`Workspace: ${workspace}`);
        const path = filepath.join(workspace, filePath);
        const stats = fs.statSync(path); // Use fs.statSync to get file stats synchronously
        if (!stats.isFile()) {
            throw new Error('Provided path is not a file.');
        }
        const data = fs.readFileSync(path, 'utf8'); // Use fs.readFileSync to read file content synchronously
        return data;
    } catch (error) {
        console.error('Error reading file:', error);
        return ''; // Return empty string or handle the error as needed
    }
}
async function fileAnalyzer(filePath, workspace) {
    const fileContent = await readFileContent(filePath, workspace);
    let temp = {};

    if (fileContent === '') {
        console.log('Error analyzing file: Empty file content');
        return ['', {}];
    }

    try {
        const jsonData = JSON.parse(fileContent);
        return ['json', jsonData];
    } catch (jsonError) {
        try {
            const parsed = HCL.parse(fileContent);
            const jsonData = JSON.parse(parsed);
            return ['hcl', jsonData];
        } catch (hclErr) {
            try {
                temp = toml.parse(fileContent);
                return ['toml', temp];
            } catch (tomlErr) {
                try {
                    temp = yaml.load(fileContent);
                    return ['yaml', temp];
                } catch (yamlErr) {
                    console.log(`Error analyzing file: Invalid configuration file format`);
                    return ['', {}];
                }
            }
        }
    }
}

function setWorkflowStatus(statusCode) {
    console.log(`KICS scan status code: ${statusCode}`);

    if (statusCode === "0") {
        return;
    }

    core.setFailed(`KICS scan failed with exit code ${statusCode}`);
}

async function main() {
    console.log("Running KICS action...");

    // Get ENV variables
    const githubToken = process.env.INPUT_TOKEN;
    let enableAnnotations = process.env.INPUT_ENABLE_ANNOTATIONS;
    let enableComments = process.env.INPUT_ENABLE_COMMENTS;
    let enableJobsSummary = process.env.INPUT_ENABLE_JOBS_SUMMARY;
    const commentsWithQueries = process.env.INPUT_COMMENTS_WITH_QUERIES;
    const excludedColumnsForCommentsWithQueries = process.env.INPUT_EXCLUDED_COLUMNS_FOR_COMMENTS_WITH_QUERIES.split(',');
    console.log("Output Path: ", process.env.INPUT_OUTPUT_PATH)
    console.log("Config Path: ", process.env.INPUT_CONFIG_PATH)
    const outputPath = await processOutputPath(process.env.INPUT_OUTPUT_PATH, process.env.INPUT_CONFIG_PATH, "/github/workspace");
    const outputFormats = process.env.INPUT_OUTPUT_FORMATS;
    const exitCode = process.env.KICS_EXIT_CODE

    console.log("Output Path: ", outputPath);
    try {
        const octokit = github.getOctokit(githubToken);
        let context = {};
        let repo = '';
        let prNumber = '';

        if (github.context) {
            context = github.context;
            if (context.repo) {
                repo = context.repo;
            }
            if (context.payload && context.payload.pull_request) {
                prNumber = context.payload.pull_request.number;
            }
        }

        enableAnnotations = enableAnnotations ? enableAnnotations : "false"
        enableComments = enableComments ? enableComments : "false"
        enableJobsSummary = enableJobsSummary ? enableJobsSummary : "false"

        const parsedResults = readJSON(outputPath.resultsJSONFile);
        if (enableAnnotations.toLocaleLowerCase() === "true") {
            annotator.annotateChangesWithResults(parsedResults);
        }
        if (enableComments.toLocaleLowerCase() === "true") {
            await commenter.postPRComment(parsedResults, repo, prNumber, octokit, commentsWithQueries.toLocaleLowerCase() === "true", excludedColumnsForCommentsWithQueries);
        }
        if (enableJobsSummary.toLocaleLowerCase() === "true") {
            await commenter.postJobSummary(parsedResults, commentsWithQueries.toLocaleLowerCase() === "true", excludedColumnsForCommentsWithQueries);
        }

        setWorkflowStatus(exitCode);
        cleanupOutput(outputPath.resultsJSONFile, outputFormats);
    } catch (e) {
        console.error(e);
    }
}

main();
