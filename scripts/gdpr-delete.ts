'use strict';
import yargs from 'yargs';
import * as AWS from 'aws-sdk';
import axios, { AxiosResponse } from 'axios';
import * as _ from 'lodash';

/*
    Script to perform a GDPR delete of AuditEvent records
    `AWS_REGION=$your-aws-region npx ts-node gdpr-delete.ts --clientId $your-cognito-client-id --username airview --password $your-airview-password --apiUrl $your-fwoa-api-url --apiKey $your-fwoa-api-key --patientId $your-patientId`
    EG: AWS_REGION=us-west-2 npx ts-node ./scripts/gdpr-delete.ts --clientId $CLIENT_ID --username airview --password $PASSWORD --apiUrl https://cr8nfyke7a.execute-api.us-west-2.amazonaws.com/dev --apiKey $API_KEY --patientId 52d4e66f-f2c7-478b-a38a-16e7b7777777
*/

function parseCmdOptions() {
    return yargs(process.argv.slice(2))
        //.usage('Usage: $0 --clientId, -c oAuth2 clientID --username, -u oAuth2 username --password, -p oAuth2 password --apiUrl -a fwoa API Url --apiKey -k fwoa API Key')
        .option('clientId', {
            alias: 'c',
            type: 'string',
            describe: 'oAuth2 client ID',
            demandOption: true
        })
        .option('username', {
            alias: 'u',
            type: 'string',
            describe: 'oAuth2 username',
            demandOption: true
        })
        .option('password', {
            alias: 'p',
            type: 'string',
            describe: 'oAuth2 password',
            demandOption: true
        })
        .option('apiUrl', {
            alias: 'au',
            type: 'string',
            describe: 'fwoa API URL',
            demandOption: true
        })
        .option('apiKey', {
            alias: 'ak',
            type: 'string',
            describe: 'fwoa API Key',
            demandOption: true
        })
        .option('patientId', {
            alias: 'pi',
            type: 'string',
            describe: 'PatientId of the patient to delete all data for',
            demandOption: true
        })
        .option('retries', {
            alias: 'r',
            type: 'number',
            describe: 'number of times to retry fwoa calls',
            default: 5
        })
        .option('wait', {
            alias: 'w',
            type: 'number',
            describe: 'millisecond wait time between retry calls',
            default: 30
        })
        .argv
};

(async ()=>{
    try {
        // get the details from standard input
        const cmdArgs = parseCmdOptions();

        // login to fwoa using the cognito AWS SDK
        console.log(`starting gdpr delete for PatientId: ${cmdArgs.patientId}`);
        
        console.log(`logging in to oAuth2 as ${cmdArgs.username}`);
        const cognito = new AWS.CognitoIdentityServiceProvider();
        const authResponse = await cognito.initiateAuth({
            AuthFlow: 'USER_PASSWORD_AUTH',
            AuthParameters: {
                USERNAME: cmdArgs.username,
                PASSWORD: cmdArgs.password
            },
            ClientId: cmdArgs.clientId,
        }).promise();
        const accessToken = authResponse?.AuthenticationResult?.AccessToken;
        if (_.isUndefined(accessToken)){
            throw new Error(`Unable to get AccessToken. ${authResponse}`);
        }
        console.log(`successfully logged in to oAuth2 as ${cmdArgs.username}`);

        // create fwoa client
        const fwoa = axios.create({
            baseURL: cmdArgs.apiUrl,
            timeout: 60000,
            headers: {
                'x-api-key': cmdArgs.apiKey,
                'Authorization': `Bearer ${accessToken}`
            },
            withCredentials: true,
        });

        // count and skip interface
        let deleteIds = new Set();
        for (let i =0; i < Infinity; i+=20){
            // parse out the next and skip
            let query = `AuditEvent?_sort=-date&patient=Patient/${cmdArgs.patientId}&_count=20&_getpagesoffset=${i}`;
            
            let searchResponse!: AxiosResponse;
            for (let j =0; j < cmdArgs.retries; j++){
                if (j !== 0) {
                    await new Promise((resolve) =>{ setTimeout(resolve, cmdArgs.wait); });
                }

                console.log(`calling GET AuditEvent ${query}`);
                searchResponse = await fwoa.get(query);

                if (searchResponse.status === 200){
                    console.log(`successfully called GET AuditEvent ${query}`);
                    break;
                } else if (j === cmdArgs.retries){
                    console.log(`Error calling GET AuditEvent ${cmdArgs.retries}x for query ${query}`);
                    console.log(searchResponse);
                    process.exit(1);
                }
            }
            
            // add all auditEventIds to the set
            let entry: any;
            for (entry of searchResponse.data.entry){
                // check if this is a delete or update
                let whatEntities = entry.resource.entity.filter((entity: any)=>{
                    return _.has(entity, 'what');
                });

                if (whatEntities.length > 1){
                    _.remove(entry.resource.entity, (entity: any)=>{
                        if (_.has(entity, 'what')){
                            return entity.what.reference === `Patient/${cmdArgs.patientId}`;
                        } else {
                            return false;
                        }
                    });
                    
                    // update
                    let putResponse!: AxiosResponse;
                    for (let j =0; j < cmdArgs.retries; j++){
                        if (j !== 0) {
                            await new Promise((resolve) =>{ setTimeout(resolve, cmdArgs.wait); });
                        }
        
                        console.log(`calling PUT AuditEvent ${entry.resource.id} to remove patientId`);
                        putResponse = await fwoa.put(
                            `AuditEvent/${entry.resource.id}`,
                            entry.resource
                        );
        
                        if (putResponse.status === 200){
                            console.log(`successfully called PUT AuditEvent ${entry.resource.id}`);
                            break;
                        } else if (j === cmdArgs.retries){
                            console.log(`Error calling PUT AuditEvent ${cmdArgs.retries}x for query ${entry.resource.id}`);
                            console.log(putResponse);
                            process.exit(1);
                        }
                    }
                } else {
                    // delete

                    // we can't just delete otherwise the paging slides forwards so accumulate ids & delete after paging
                    deleteIds.add(entry.resource.id);
                }
            }
            
            if (searchResponse.data.entry.length < 20){
                break;
            }
        }

        for (let deleteId of deleteIds){

            let deleteResponse! : AxiosResponse;
            for (let i = 0; i < cmdArgs.retries; i++){
                if (i !== 0) {
                    await new Promise((resolve) =>{ setTimeout(resolve, cmdArgs.wait); });
                }

                console.log(`calling DELETE AuditEvent ${deleteId}`)
                deleteResponse = await fwoa.delete(`AuditEvent/${deleteId}`);

                // confirm we've successfully deleted
                if (deleteResponse.status === 200) {
                    console.log(`successfully called DELETE AuditEvent ${deleteId}`);
                    break;
                } else if (i === cmdArgs.retries){
                    console.log(`Error calling DELETE AuditEvent ${cmdArgs.retries}x for AuditEvent id: ${deleteId}`);
                    console.log(deleteResponse);
                    process.exit(1);
                }
            }
        }

        console.log(`successfully completed gdpr delete for patientId: ${cmdArgs.patientId}`);
    } catch (err){
        console.log('Error performing GDPR delete');
        console.log(err);
        process.exit(1);
    }
})();