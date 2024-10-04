# ECE46100-Team

## Members

* Nathan Bitner
* Calvin Madsen
* Tonmoy Rakshit
* Zinat Adeleye
* Osan Omayuku

# GitHub Repository Analysis Tool

## Purpose

This tool is designed to analyze GitHub repositories and calculate various metrics to assess their quality and maintainability. It provides scores for the following metrics:

1. Ramp Up Time
2. Correctness
3. Bus Factor
4. Responsive Maintainer
5. License

The tool can process multiple URLs, resolve npm packages to their corresponding GitHub repositories, and output the results in NDJSON format.

## Configuration

The program can be run through the "run" script in the root directory, key arguments below

### Prerequisites

- Node.js 
- npm 

### Environment Variables

Create a `.env` file in the root directory of the project with the following content:

```
GITHUB_TOKEN=your_github_personal_access_token
LOG_LEVEL=1
LOG_FILE=/path/to/your/logfile.log
```

Replace `your_github_personal_access_token` with your actual GitHub Personal Access Token. You can generate one [here](https://github.com/settings/tokens).

The `LOG_LEVEL` can be set to:
- 0: Silent (no logging)
- 1: Information messages
- 2: Debug messages

Set `LOG_FILE` to the desired path for your log file.

### Installation

To install the required dependencies, run:

```bash
./run install
```

This will install all necessary npm packages for the project.

## Usage

The tool can be invoked in three modes:

### 1. Install Dependencies

To install or update project dependencies:

```bash
./run install
```
This will install all required npm packages for the project.

### 2. Analyze Repositories

To analyze a list of repository URLs:

```bash
./run /path/to/url_file.txt
```

The `url_file.txt` should contain one URL per line. The tool will output the results in NDJSON format to stdout.

### 3. Run Tests

To run the test suite:

```bash
./run test
```

This will execute the test cases and display the results, including the number of passed tests and the test coverage percentage.


## Output Format

The tool outputs results in NDJSON format. Each line represents a single repository analysis result:

```json
{"URL":"https://github.com/example/repo", "NetScore":0.8, "NetScore_Latency":0.1, "RampUp":0.7, "RampUp_Latency":0.05, "Correctness":0.9, "Correctness_Latency":0.03, "BusFactor":0.6, "BusFactor_Latency":0.02, "ResponsiveMaintainer":0.8, "ResponsiveMaintainer_Latency":0.04, "License":1, "License_Latency":0.01}
```

## Logging

The tool logs its operations to the file specified in the `LOG_FILE` environment variable. The verbosity of logging is controlled by the `LOG_LEVEL` environment variable.

## Error Handling

If the tool encounters any errors during execution, it will log the error and exit with a non-zero status code. Error messages will be output to stderr in JSON format:

```json
{"error": "Error message description"}
```

For more detailed information about the project's implementation and metrics calculation, please refer to the source code and comments within the `index.ts` file.