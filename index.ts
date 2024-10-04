/**
 * This file contains the main logic for a GitHub repository analysis tool.
 * It calculates various metrics for GitHub repositories, including:
 * - Ramp Up Time
 * - Correctness
 * - Bus Factor
 * - Responsive Maintainer
 * - License
 * 
 * The tool can process multiple URLs, resolve npm packages to GitHub repositories,
 * and output the results in NDJSON format.
 */

import { promises as fs, existsSync, mkdirSync, readFileSync, unlink } from 'fs';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { execSync } from 'child_process';
import * as path from 'path';
import axios from 'axios';
import * as http from 'isomorphic-git/http/node';
import * as git from 'isomorphic-git';
const { promisify } = require('util');
const { exec } = require('child_process');

// Check for required environment variables
if (!process.env.LOG_FILE) {
  console.error(JSON.stringify({ error: "LOG_FILE environment variable is not set" }));
  process.exit(1);
}

if (!process.env.GITHUB_TOKEN) {
  console.error(JSON.stringify({ error: "GITHUB_TOKEN environment variable is not set" }));
  process.exit(1);
}

// 0 means silent, 1 means informational messages, 2 means debug messages). Default log verbosity is 0.
const LOG_FILE = process.env.LOG_FILE;
const LOG_LEVEL = parseInt(process.env.LOG_LEVEL || '0', 10);

/**
 * Logs a message to the specified log file if the message's log level is less than or equal to LOG_LEVEL
 * @param message The message to log
 * @param level The log level of the message (default: 1)
 */
async function log(message: string, level: number = 1): Promise<void> {
  if (level <= LOG_LEVEL) {
    // Check if the log file exists
    const logFileExists = await fs.access(LOG_FILE)
      .then(() => true)
      .catch(() => false);

    if (!logFileExists) {
      const logDir = path.dirname(LOG_FILE);
      await fs.mkdir(logDir, { recursive: true });
    }

    // Format the date
    const now = new Date();
    const formattedDate = now.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).replace(/(\d+)\/(\d+)\/(\d+),/, '$3-$1-$2');

    // Append the message to the log file
    const logMessage = `${formattedDate} - ${message}\n`;
    await fs.appendFile(LOG_FILE, logMessage);
  }
}

/**
 * Fetches the GitHub repository URL for a given npm package
 * @param packageName The name of the npm package
 * @returns The GitHub repository URL if found, null otherwise
 */
async function getGithubRepoFromNpm(packageName: string): Promise<string | null> {
  try {
    // Fetch package metadata from npm Registry
    const response = await axios.get(`https://registry.npmjs.org/${packageName}`);
    const data = response.data;

    // Extract repository URL from metadata
    const repository = data.repository;
    if (repository && repository.type === 'git') {
      // Return the GitHub repository URL if it's a git repository
      return repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
    }

    // Repository URL is not available or it's not a GitHub URL
    return null;
  } catch (error) {
    await log(`Error fetching data for package ${packageName}: ${error}`, 2);
    return null;
  }
}

interface MetricResult {
  score: number;
  latency: number;
}

/**
 * Base Metric class that all specific metrics inherit from
 */
abstract class Metric {
  public  url: string;
  public weight: number;
  protected owner: string;
  protected repo: string;

  constructor(url: string, weight: number) {
    this.url = url;
    this.weight = weight;
    this.owner = '';
    this.repo = '';
  }

  setUrl(url: string): void {
    this.url = url;
  }

  protected extractOwnerAndRepo(): void {
    const urlParts = this.url.split('/');
    this.owner = urlParts[3];
    this.repo = urlParts[4];
  }

  static getWeight(): number {
    throw new Error("getWeight must be implemented by subclasses");
  }

  abstract calculate(): Promise<MetricResult>;
}

/**
 * RampUp class for calculating the ramp-up time metric
 */
class RampUp extends Metric {
  protected discussionCount: number;
  protected score_calculation: number;
  protected lenREADME: number;

  constructor(url: string) {
    super(url, 1);
    this.discussionCount = 0;
    this.score_calculation = 0;
    this.lenREADME = 0;
  }

  static getWeight(): number {
    return 1;
  }

  /**
   * Fetches the number of discussions in the repository
   */
  async getNumDiscussions(): Promise<number>{
    const discussionResponse = await axios.get(`https://api.github.com/repos/${this.owner}/${this.repo}/discussions`, {
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    return Object.keys(discussionResponse.data).length;
  }

  /**
   * Fetches the length of the README file
   */
  async getLenREADME(): Promise<number>{
    const README_response = await axios.get(`https://api.github.com/repos/${this.owner}/${this.repo}/readme`, {
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    return README_response.data.content.length;
  }

  /**
   * Calculates the ramp-up score based on discussions and README length
   */
  async calculate(): Promise<MetricResult> {
    const startTime = Date.now();
    this.discussionCount = 0;
    this.score_calculation = 0;

    this.extractOwnerAndRepo();

    try {
      this.discussionCount = await this.getNumDiscussions();
    } catch (error) {
      this.discussionCount = 0;

      if (axios.isAxiosError(error) && error.response?.status === 410) {
        // 410 means discussions are disabled
        await log(`Discussions disabled on ${this.url}`, 2);
      }else if (axios.isAxiosError(error) && error.response?.status === 404) {
        // 404 means no discussions present
        await log(`No discussions on ${this.url}`, 2);
      }else {
        // For any other error, log it and return a score of 0
        await log(`Error checking discussions for ${this.url}: ${error}`, 2);
      }
    }

    // README check
    try {
      this.lenREADME = await this.getLenREADME();
    } catch (error) {
      await log(`Error checking discussions for ${this.url}: ${error}`, 2);
      this.lenREADME = 0;
    }

    // Calculate latency
    const latency = (Date.now() - startTime) / 1000; // Convert to seconds

    //discussion calculation
    if (this.discussionCount >=10){
      this.score_calculation += 0.5;
    }
    else{
      this.score_calculation += this.discussionCount / 10;
    }
    // readme calculation
    if (this.lenREADME != 0){
      // good length /  too short
      if (this.lenREADME <= 5000){
        this.score_calculation += 0.75 * (this.lenREADME / 5000);
      }
      // too long
      else{
        this.score_calculation += 0.75 * (10000 / this.lenREADME);
      }
    }
    else{
      this.score_calculation += 0; // no README
    }
    return {score: this.score_calculation > 1 ? 1 : this.score_calculation, latency};
  }
}

/**
 * Correctness class for calculating the correctness metric
 * This metric is based on two sub-metrics:
 * 1. Last CI job status (50% weight)
 *    The last CI job status is determined by the conclusion of the latest GitHub Actions run.
 * 2. Pull request fix ratio (50% weight)
 *    The pull request fix ratio is calculated as the ratio of open pull requests that contain 'fix' 'bug' or 'issue' in the title.
 * The final score is a weighted average of the two sub-metrics.
 */
class Correctness extends Metric {
  constructor(url: string) {
    super(url, 1);
  }

  static getWeight(): number {
    return 1;
  }

  async isLastJobSuccessful(): Promise <number>{
    
    // TODO: can we only call the latest run? (instaed of calling all then only using the last one)
    // getting last run id
    try{
      const run_id_response = await axios.get(`https://api.github.com/repos/${this.owner}/${this.repo}/actions/runs`, {
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      // if no CI are present (not as good as if they had made some and passed)
      if (run_id_response.data.total_count == 0){
        return .75;
      }
      const run_id = run_id_response.data.workflow_runs[0].id;

      // getting last job status from last run id
      const runID_jobs_response = await axios.get(`https://api.github.com/repos/${this.owner}/${this.repo}/actions/runs/${run_id}/jobs`, {
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      // if no jobs are present (not as good as if they had made some and passed)
      if (runID_jobs_response.data.total_count == 0){
        return 0.75; 
      }
      // main return value
      return runID_jobs_response.data.jobs[0].conclusion == 'success' ? 1 : 0;
    } catch (error){
      
      await log(`Error checking CI job status for ${this.url}: ${error}`, 2);
      return 0;
    }
  }
  async getPullRequestFixRatio(): Promise <number>{
    
    // Listing pull requests
    try{
      let numOpenPullFixes = 0;
      const pullsListResponse = await axios.get(`https://api.github.com/repos/${this.owner}/${this.repo}/pulls`, {
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
    
    // using results from API call to get number of pull requests
    const numPullRequests = pullsListResponse.data.length > 30 ? 30 : pullsListResponse.data.length;
    for (let i = 0; i < numPullRequests; i++){

      // checks if pull request is open and contains 'fix' or 'bug' in title
      const pullData = pullsListResponse.data[i];
      if (pullData.state == 'open'){
        if (pullData.title.includes('fix') || pullData.title.includes('bug') || pullData.title.includes('issue')){
          numOpenPullFixes++;
        } 
      }
    }
    // return the ratio of open pull requests that are fixes
    if (numPullRequests == 0){
      return 0.75;
    }
    return  (numPullRequests - numOpenPullFixes) / numPullRequests;
  }
    catch (error){
      await log(`Error checking pull request info for ${this.url}: ${error}`, 2);
      return 0;
    }
  }

  async calculate(): Promise<MetricResult> {
    this.extractOwnerAndRepo();
    const startTime = Date.now();

    // getting last job status (error handling in function)
    const lastJobStatus = await this.isLastJobSuccessful();

    // try getting pull request info (error handling in function)
    const getPullRequestFixRatio = await this.getPullRequestFixRatio();

    const latency = (Date.now() - startTime) / 1000; // Convert to seconds

    return { score: 0.5 * lastJobStatus + 0.5 * getPullRequestFixRatio, latency};
  }
}

/**
 * BusFactor class for calculating the bus factor metric
 */
class BusFactor extends Metric {

  constructor(url: string) {
    super(url, 3); // weight
  }

  static getWeight(): number {
    return 3;
  }

  /**
   * Calculates the bus factor score based on the number of contributors
   */
  async calculate(): Promise<MetricResult> {
    const startTime = Date.now();
      
    try {
      // Extract owner and repo from the GitHub URL
      this.extractOwnerAndRepo();

      // Make a request to the GitHub API to get the contributors
      const response = await axios.get(`https://api.github.com/repos/${this.owner}/${this.repo}/contributors`, {
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      const contributors = response.data;
      const contributorCount = contributors.length;

      // Calculate latency
      const latency = (Date.now() - startTime) / 1000; // Convert to seconds

      // Define thresholds for scoring based on the number of contributors
      let score = 0;
      if (contributorCount >= 30) {
        score = 1; // Very healthy project
      } else {
        score = contributorCount / 30; // Linear scaling for projects with less than 30 contributors
      }

      return { score, latency };

    } catch (error) {
      const latency = (Date.now() - startTime) / 1000;

      // Handle errors, such as a repository with no contributors or API errors
      if (axios.isAxiosError(error)) {
        await log(`Error retrieving contributors for ${this.url}: ${error}`, 2);
      }

      // Return a score of 0 in case of any error
      return { score: 0, latency };
    }
  }
}

/**
 * ResponsiveMaintainer Class
 * 
 * This class extends the Metric class and is designed to calculate a responsiveness score
 * for a GitHub repository maintainer. It assesses the repository's maintenance quality
 * based on three main factors:
 * 
 * 1. Issue handling (40% of the score)
 * 2. Pull request management (40% of the score)
 * 3. Commit frequency (20% of the score)
 * 
 * The class uses the GitHub API to fetch relevant data and calculates individual scores
 * for each factor, which are then combined into an overall weighted score.
 */
class ResponsiveMaintainer extends Metric {

  constructor(url: string) {
    super(url, 2);  // NetScore weight is 2
  }

  static getWeight(): number {
    return 2;
  }

  /**
   * Calculates the overall responsiveness score for the repository
   * @returns A Promise resolving to a MetricResult object containing the score and latency
   */
  async calculate(): Promise<MetricResult> {
    const startTime = Date.now();

    // Extract owner and repo from the URL
    this.extractOwnerAndRepo();
    
    try {
      // Fetch all required metrics concurrently
      const [issueMetrics, pullRequestMetrics, commitFrequency] = await Promise.all([
        this.getIssueMetrics(),
        this.getPullRequestMetrics(),
        this.getCommitFrequency()
      ]);

      // Calculate individual scores
      const issueScore = this.calculateIssueScore(issueMetrics);
      const prScore = this.calculatePRScore(pullRequestMetrics);
      const commitScore = this.calculateCommitScore(commitFrequency);

      // Calculate overall score (weighted average)
      const overallScore = (issueScore * 0.4 + prScore * 0.4 + commitScore * 0.2);

      const latency = (Date.now() - startTime) / 1000; // Convert to seconds
      return { score: overallScore, latency };
    } catch (error) {
      await log(`Error calculating ResponsiveMaintainer score for ${this.url}: ${error}`, 2);
      return { score: 0, latency: (Date.now() - startTime) / 1000 };
    }
  }

  /**
   * Fetches issue-related metrics from the GitHub API
   * @returns An object containing average resolution time and open issues ratio
   */
  private async getIssueMetrics(): Promise<{ avgResolutionTime: number, openIssuesRatio: number }> {
    try {
      const response = await axios.get(`https://api.github.com/repos/${this.owner}/${this.repo}/issues?state=all&per_page=100`, {
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
      });

      const issues = response.data;
      const closedIssues = issues.filter((issue: any) => issue.state === 'closed');
      const totalIssues = issues.length;

      // Calculate average resolution time in days
      const resolutionTimes = closedIssues.map((issue: any) => {
        const createdAt = new Date(issue.created_at);
        const closedAt = new Date(issue.closed_at);
        return (closedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
      });

      const avgResolutionTime = resolutionTimes.length > 0 ? resolutionTimes.reduce((a: number, b: number) => a + b, 0) / resolutionTimes.length : Infinity;
      const openIssuesRatio = totalIssues > 0 ? (totalIssues - closedIssues.length) / totalIssues : 1;

      return { avgResolutionTime, openIssuesRatio };
    } catch (error) {
      await this.handleApiError('getIssueMetrics', error);
      return { avgResolutionTime: Infinity, openIssuesRatio: 1 }; // Worst case scenario
    }
  }

  /**
   * Fetches pull request-related metrics from the GitHub API
   * @returns An object containing average merge time and open PRs ratio
   */
  private async getPullRequestMetrics(): Promise<{ avgMergeTime: number, openPRsRatio: number }> {
    try {
      const response = await axios.get(`https://api.github.com/repos/${this.owner}/${this.repo}/pulls?state=all&per_page=100`, {
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
      });

      const prs = response.data;
      const mergedPRs = prs.filter((pr: any) => pr.merged_at);
      const totalPRs = prs.length;

      // Calculate average merge time in days
      const mergeTimes = mergedPRs.map((pr: any) => {
        const createdAt = new Date(pr.created_at);
        const mergedAt = new Date(pr.merged_at);
        return (mergedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
      });

      const avgMergeTime = mergeTimes.length > 0 ? mergeTimes.reduce((a: number, b: number) => a + b, 0) / mergeTimes.length : Infinity;
      const openPRsRatio = totalPRs > 0 ? (totalPRs - mergedPRs.length) / totalPRs : 1;

      return { avgMergeTime, openPRsRatio };
    } catch (error) {
      await this.handleApiError('getPullRequestMetrics', error);
      return { avgMergeTime: Infinity, openPRsRatio: 1 }; // Worst case scenario
    }
  }

  /**
   * Fetches the number of commits made in the last year
   * @returns The number of commits made in the last year
   */
  private async getCommitFrequency(): Promise<number> {
    try {
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      const response = await axios.get(`https://api.github.com/repos/${this.owner}/${this.repo}/commits?since=${oneYearAgo.toISOString()}&per_page=100`, {
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
      });

      return response.data.length;
    } catch (error) {
      await this.handleApiError('getCommitFrequency', error);
      return 0; // Worst case scenario: no commits
    }
  }

  /**
   * Calculates the issue handling score based on average resolution time and open issues ratio
   * @param metrics Object containing avgResolutionTime and openIssuesRatio
   * @returns A score between 0 and 1
   */
  private calculateIssueScore(metrics: { avgResolutionTime: number, openIssuesRatio: number }): number {
    const resolutionScore = metrics.avgResolutionTime === Infinity ? 0 : Math.max(0, 1 - (metrics.avgResolutionTime / 30)); // Assuming 30 days as a limit
    const openIssuesScore = 1 - metrics.openIssuesRatio;
    return (resolutionScore + openIssuesScore) / 2;
  }

  /**
   * Calculates the pull request management score based on average merge time and open PRs ratio
   * @param metrics Object containing avgMergeTime and openPRsRatio
   * @returns A score between 0 and 1
   */
  private calculatePRScore(metrics: { avgMergeTime: number, openPRsRatio: number }): number {
    const mergeScore = metrics.avgMergeTime === Infinity ? 0 : Math.max(0, 1 - (metrics.avgMergeTime / 7)); // Assuming 7 days as a limit
    const openPRsScore = 1 - metrics.openPRsRatio;
    return (mergeScore + openPRsScore) / 2;
  }

  /**
   * Calculates the commit frequency score based on the number of commits in the last year
   * @param commitFrequency Number of commits in the last year
   * @returns A score between 0 and 1
   */
  private calculateCommitScore(commitFrequency: number): number {
    // Assuming 52 commits (1 per week) as a good baseline for active maintenance
    return Math.min(1, commitFrequency / 52);
  }

  /**
   * Handles and logs API errors
   * @param method The name of the method where the error occurred
   * @param error The error object
   */
  private async handleApiError(method: string, error: any): Promise<void> {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        switch (error.response.status) {
          case 404:
            await log(`${method}: Repository not found or API endpoint doesn't exist`, 2);
            break;
          case 403:
            await log(`${method}: API rate limit exceeded or lacking permissions`, 2);
            break;
          case 401:
            await log(`${method}: Unauthorized. Check your GitHub token`, 2);
            break;
          default:
            await log(`${method}: API request failed with status ${error.response.status}`, 2);
        }
      } else if (error.request) {
        await log(`${method}: No response received from the server`, 2);
      } else {
        await log(`${method}: Error setting up the request`, 2);
      }
    } else {
      await log(`${method}: Non-Axios error occurred: ${error}`, 2);
    }
  }
}

/**
 * License Class
 * 
 * This class extends the Metric class and is designed to check if a GitHub repository
 * has a compatible license. It uses the isomorphic-git library to clone the repository
 * The score is binary: 1 if a license is compatible, 0 otherwise.
 * also stores the license (and README if needed) in a local directory for future reference
 * NO API CALLS
 */
class License extends Metric {

  constructor(url: string) {
    super(url, 1);  // License weight is 1
  }

  static getWeight(): number {
    return 1;
  }

  // clones license from repoURL into dir
  // TODO urls with ssh will not work, sometimes happens with npm packages
  private async cloneLicenseFile(repoUrl: string): Promise<string> {
    
    const dir =`./repo-licenses/${this.repo}`;
    // Ensure the directory exists
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  
    // Clone the repository
    await git.clone({
      fs,
      http,
      dir,
      url: repoUrl,
      singleBranch: true,
      depth: 1,
      noCheckout: true,
    });
  
    // Checkout only the LICENSE file
    await git.checkout({
      fs,
      dir,
      ref: 'HEAD',
      filepaths: ['LICENSE'],
      force: true,
    });

    // get license from local directory, different extensions used
    const licenseFiles = ['/LICENSE', '/LICENSE.md', '/LICENSE.txt'];
    for (const file of licenseFiles) {
      const licensePathWithFile = path.join(dir, file);
      if (existsSync(licensePathWithFile)) {
      const licenseContent = readFileSync(licensePathWithFile, 'utf8');
      await log(`Found ${file} for: ${repoUrl}`, 2);
      return licenseContent;
      }
    }

    // Could not find LICENSE in local directory
    await log(`LICENSE not found for: ${repoUrl}`, 2);
    return 'null';
  }

  /**
   * Clones the README file from the repository and checks for the word "license"
   * @returns The contents of the README file if it contains the word "license", 'null' otherwise
   * only runs if no LICENSE file is found
   */
  private async cloneREADMElicense(): Promise<string> {
    const dir = `./repo-readmes/${this.repo}`;
    // Ensure the directory exists
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Clone the repository
    await git.clone({
      fs,
      http,
      dir,
      url: this.url,
      singleBranch: true,
      depth: 1,
      noCheckout: true,
    });

    // Checkout only the README file
    await git.checkout({
      fs,
      dir,
      ref: 'HEAD',
      filepaths: ['README.md'],
      force: true,
    });

    // Read the README file
    const readmePath = path.join(dir, 'README.md');
    if (existsSync(readmePath)) {
      const readmeContent = readFileSync(readmePath, 'utf8');
      if (readmeContent.toLowerCase().includes('license')) {
        await log(`Found "license" in README for: ${this.url}`, 2);
        return readmeContent;
      }
    }

    await log(`"license" not found in README for: ${this.url}`, 2);
    return 'null';
  }

  /**
   * Calculates the license score for the repository
   * @returns A Promise resolving to a MetricResult object containing the score and latency
   */
  async calculate(): Promise<MetricResult> {
    const startTime = Date.now();
    this.extractOwnerAndRepo();

    // checking for license file
    try {
      // Extract owner and repo from the GitHub URL
      const license = await this.cloneLicenseFile(this.url);
      
      if (license != 'null'){
        // Calculate latency
        const latency = (Date.now() - startTime) / 1000; // Convert to seconds
        // Return a score of 1 if license is compatable, 0 otherwise
        if (license.includes('MIT') || license.includes('Apache 2.0') || license.includes('GPLv2') || license.includes('GNU')) {
          return { score: 1, latency };
        }
      }
    } catch (error) {
      await log(`Error checking license for ${this.url}: ${error}`, 2);
    }

    // checking for license in README
    // only runs if no LICENSE file is found
    try{
    const READMElicense = await this.cloneREADMElicense();
    if (READMElicense != 'null'){
      const latency = (Date.now() - startTime) / 1000;
      if (READMElicense.includes('MIT') || READMElicense.includes('Apache 2.0') || READMElicense.includes('GPLv2') || READMElicense.includes('GNU')) {
        return { score: 1, latency };
      }
  }
  } catch (error) {
    await log(`Error checking README for license for ${this.url}: ${error}`, 2);
  }
    // return a score of 0 if no license is found or not one of the compatable licenses
    const latency = (Date.now() - startTime) / 1000;
    return { score: 0, latency };
    }
  }

/**
 * URLHandler Class
 * 
 * This class is responsible for processing a given URL, creating instances of various
 * metric classes, calculating their scores, and combining them into a final result.
 * It also handles the conversion of npm package URLs to GitHub repository URLs.
 */
class URLHandler {
  private url: string;
  private metricClasses: (typeof Metric)[];

  constructor(url: string) {
    this.url = url;
    this.metricClasses = [RampUp, Correctness, BusFactor, ResponsiveMaintainer, License];
  }

  /**
   * Resolves an npm package URL to its corresponding GitHub repository URL
   * @param url The npm package URL
   * @returns A Promise resolving to the GitHub repository URL or the original URL if not found
   */
  private async resolveNpmToGithub(url: string): Promise<string> {
    if (url.includes("npmjs.com")) {
      const packageName = url.split('/').pop();
      if (!packageName) {
        return url;
      }
      const githubRepo = await getGithubRepoFromNpm(packageName);

      if (githubRepo) {
        await log(`Found GitHub repository for package ${packageName}: ${githubRepo}`, 1);
        return githubRepo;
      } else {
        return url;
      }
    }
    return url;
  }

  private createWorker(MetricClass: typeof Metric, url: string): Promise<{ score: number; latency: number }> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: { metricClassName: MetricClass.name, url }
      });

      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0)
          reject(new Error(`Worker stopped with exit code ${code}`));
      });
    });
  }

  /**
   * Processes the URL by calculating scores for all metrics and combining them
   * Process the metrics in parallel
   * @returns A Promise resolving to a JSON string containing all metric scores and latencies
   */
  async processURL(): Promise<string> {
    const results: any = {};
    let weightedScoreSum = 0;
    let totalWeight = 0;
    let netScoreLatency = 0;

    const startTime = Date.now();

    // Resolve npm URL to GitHub if necessary
    const resolvedUrl = await this.resolveNpmToGithub(this.url);

    // Create workers for each metric
    const workerPromises = this.metricClasses.map(MetricClass => 
      this.createWorker(MetricClass, resolvedUrl)
    );

    // Wait for all workers to complete
    const metricResults = await Promise.all(workerPromises);

    // Process results
    this.metricClasses.forEach((MetricClass, index) => {
      const { score, latency } = metricResults[index];
      const metricName = MetricClass.name;
      const weight = MetricClass.getWeight(); 

      results[metricName] = Number(score.toFixed(3));
      results[`${metricName}_Latency`] = Number(latency.toFixed(3));

      weightedScoreSum += score * weight;
      totalWeight += weight;
    });

    netScoreLatency = (Date.now() - startTime) / 1000; // Convert to seconds

    // Calculate NetScore and NetScore_Latency
    const netScore = Number((weightedScoreSum / totalWeight).toFixed(3));
    const netScoreLatencyRounded = Number(netScoreLatency.toFixed(3));

    // Create the final output object with NetScore and NetScore_Latency first
    const finalOutput = {
      URL: this.url,
      NetScore: netScore,
      NetScore_Latency: netScoreLatencyRounded,
      ...results
    };

    return JSON.stringify(finalOutput);
  }
} 

if (!isMainThread) {
  const metricClasses = {
    RampUp,
    Correctness,
    BusFactor,
    ResponsiveMaintainer,
    License
  };

  const runMetric = async () => {
    const { metricClassName, url } = workerData;
    const MetricClass = metricClasses[metricClassName as keyof typeof metricClasses];
    
    if (!MetricClass) {
      throw new Error(`Unknown metric class: ${metricClassName}`);
    }

    const metric = new MetricClass(url);
    const result = await metric.calculate();

    if (parentPort) {
      parentPort.postMessage(result);
    } else {
      console.error('parentPort is null');
    }
  };

  runMetric().catch(error => {
    console.error(error);
    process.exit(1);
  });
}


/**
 * Checks if a given string is a valid URL
 * @param url The string to check
 * @returns true if the string is a valid URL, false otherwise
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Processes a file containing URLs
 * @param urlFile The path to the file containing URLs
 */
async function processURLs(urlFile: string): Promise<void> {
  try {
    const urls = await fs.readFile(urlFile, 'utf-8');
    const urlList = urls.split('\n').filter(url => url.trim() !== '');

    for (const url of urlList) {
      if (!isValidUrl(url)) {
        await log(`Invalid URL: ${url}`, 2);
        continue;
      }

      await log(`Processing URL: ${url}`, 1);

      const handler = new URLHandler(url);
      const result = await handler.processURL();
      console.log(result); // This will output each result as a separate line in NDJSON format

      await log(`Finished Processing URL: ${url}`, 1);
    }
  } catch (error) {
    console.error(JSON.stringify({ error: `Error processing URLs: ${error}` }));
    await log(`Error processing URLs: ${error}`, 2);
    process.exit(1);
  }
}

/**
 * Runs tests and logs the results
 */
async function runTests(): Promise<void> {
  log('Running tests', 1);

  try {
    // Run Jest with coverage
    const result = execSync('npm test', { encoding: 'utf-8' });

    // Parse the Jest output
    const lines = result.split('\n');

    const lineCoverage = lines.find((line) => line.includes('All files'))?.split('|')[4].trim();
    const testSummary = lines.find((line) => line.includes('Tests:'));
    const [, passed, total] = testSummary?.match(/(\d+) passed, (\d+) total/) || [];

    console.log(`Total: ${total}`);
    console.log(`Passed: ${passed}`);
    console.log(`Coverage: ${lineCoverage}%`);

    console.log(
      `${passed}/${total} test cases passed. ${lineCoverage}% line coverage achieved.`
    );

    await log('Tests completed', 1);
  } catch (error) {
    console.error('Error running tests:', error);
    await log(`Error running tests: ${error}`, 2);
  }
}


// Export the necessary functions and classes
export {URLHandler, Metric, RampUp, Correctness, BusFactor, ResponsiveMaintainer, License, 
        isValidUrl, processURLs, getGithubRepoFromNpm, log};

/**
 * Main function that handles command-line arguments and executes the appropriate action
 */
async function main(): Promise<void> {
  const command = process.argv[2];

  // check if GITHUB_TOKEN is valid
  axios.get('https://api.github.com', {
    headers: {
      'Authorization': `token ${process.env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  }).then(() => {
    log('GITHUB_TOKEN is valid', 2);
  }).catch(() => {
    console.error("GITHUB_TOKEN is invalid");
    log('GITHUB_TOKEN is invalid', 2);
    process.exit(1);
  });

  switch (command) {
    case 'test':
      log('Test Case', 1);
      await runTests();
      break;
    default:
      if (command) {
        log('URL Case', 1);
        await processURLs(command);
      } else {
        const errorMessage = 'Invalid command. Usage: ./run [install|test|URL_FILE]';
        console.error(JSON.stringify({ error: errorMessage }));
        await log(`Invalid command ${command}. ${errorMessage}`, 2);
        process.exit(1);
      }
  }

  process.exit(0);
}

// Execute the main function and handle any uncaught errors
if (isMainThread) {
  if (require.main === module) {
    main().catch(async (error) => {
      console.error(JSON.stringify({ error: `Fatal error: ${error}` }));
      await log(`Fatal error: ${error}`, 1);
      process.exit(1);
    });
  }
}