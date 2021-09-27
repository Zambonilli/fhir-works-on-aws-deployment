import sql from 'mssql';
import AWS from 'aws-sdk';

const INSERT = 'INSERT';
const MODIFY = 'MODIFY';
const REMOVE = 'REMOVE';

exports.handler = async (event: any) => {
    try {
        // indepotent connect call; connects if not connected
        // or returns the global pool that is used across invocations
        await sql.connect({
            user: process.env.DB_USER,
            password: process.env.DB_PWD,
            database: process.env.DB_NAME,
            server: process.env.SERVER
        });

        for (let i = 0; i < event.Records.length; i += 1) {
            const record = event.Records[i];
            console.log(JSON.stringify(record));
            const request = new sql.Request();
            let procedureName = '';
            
            switch (record.eventName){
                case INSERT:
                    procedureName = 'chp_insert_note';
                    request.input('date_updated', sql.DateTime, Date.now().toString());
                    request.input('note', sql.NChar, Buffer.from(record.dynamodb.NewImage.content.attachment.data), 'base64').toString('utf8');
                    request.input('easy_care_number', sql.BigInt, Number.parseInt(record.dynamodb.NewImage.subject.reference.split('/')[1]));
                    request.input('user_fhir_uuid', sql.BigInt, Number.parseInt(record.dynamodb.NewImage.author.reference.split('/')[1]));
                    break;
                case MODIFY:
                    procedureName = 'chp_update_note';
                    request.input('date_updated', sql.DateTime, Date.now().toString());
                    request.input('note', sql.NChar, record.dynamodb.NewImage.content.attachment.data);
                    request.input('patient_id', sql.BigInt, Number.parseInt(record.dynamodb.NewImage.subject.reference.split('/')[1]));
                    request.input('user_id', sql.BigInt, Number.parseInt(record.dynamodb.NewImage.author.reference.split('/')[1]));
                    request.input('id', sql.BigInt, await getEcoIdFromFhirId(record.dynamodb.NewImage.id));
                    break;
                case REMOVE:
                    procedureName = 'chp_delete_note';
                    request.input('id', sql.BigInt, 1);
                    break;
            }

            try {
                const result = await request.execute(procedureName);

                if (record.eventName === INSERT){
                    // we have to update the FHIR id to sql id table for ported tables
                    await setFhirIdToEcoId(record.dynamodb.NewImage.id, result.recordset);
                }
            } catch (err){
                // write to SQS in the real deal
                console.log('Failed to write record to SQL Server');
                console.log(JSON.stringify(err));
            }
        }
    } catch (ex){
        console.log('Fatal error');
        console.log(JSON.stringify(ex));
        process.exit(1);
    }
};

const getEcoIdFromFhirId = async (fhirId)=>{
    const dynamodb = new AWS.DynamoDB();
    const result = await dynamodb.getItem({
        Key: {
            fhirId: fhirId
        },
        TableName: 'fhir-id-to-eco-id-xref'
    }).promise();

    return Number.parseInt(result.data.Item.ecoId.N);
};

const setFhirIdToEcoId = async (fhirId, ecoId)=>{
    const dynamodb = new AWS.DynamoDB();
    const result = await dynamodb.putItem({
        Item: {
            fhirId: {
                S: fhirId
            },
            ecoId: {
                N: ecoId.toString()
            }
        },
        TableName: 'fhir-id-to-eco-id-xref'
    }).promise();
};

/*
ALTER TABLE easycare_user add fhir_uuid uniqueidentifier NOT NULL DEFAULT newid();
CREATE PROCEDURE chp_insert_note 
(
    @date_updated DATETIME,
    @note NVARCHAR(400),
    @easy_care_number NVARCHAR(40),
    @user_fhir_uuid UNIQUEIDENTIFIER
)
AS
BEGIN
    DECLARE @patient_id BIGINT;
    DECLARE @user_id BIGINT;
    SELECT @patient_id = p.id FROM patient p WHERE p.easy_care_number=@easy_care_number;
    SELECT @user_id = u.id FROM easycare_user u WHERE u.fhir_uuid=@user_fhir_uuid;

    INSERT INTO note (
        date_updated,
        note,
        patient_id,
        user_id
    ) VALUES (
        @date_updated,
        @note,
        @patient_id,
        @user_id
    );

    SELECT SCOPE_IDENTITY();
END
GO
CREATE PROCEDURE chp_update_note 
(
    @id BIGINT,
    @date_updated DATETIME,
    @note NVARCHAR(400),
    @easy_care_number NVARCHAR(40),
    @user_fhir_uuid UNIQUEIDENTIFIER
)
AS
BEGIN
    DECLARE @patient_id BIGINT;
    DECLARE @user_id BIGINT;
    SELECT @patient_id = p.id FROM patient p WHERE p.easy_care_number=@easy_care_number;
    SELECT @user_id = u.id FROM easycare_user u WHERE u.fhir_uuid=@user_fhir_uuid;

    UPDATE note SET
        date_updated=@date_updated,
        note=@note,
        patient_id=@patient_id,
        user_id=@user_id
    WHERE
        id=@id;
END
GO
CREATE PROCEDURE chp_delete_note 
(
    @id BIGINT
)
AS
BEGIN
    DELETE FROM note WHERE id=@id;
END
GO

INSERT INTO organisation (
    name,
    password_reset_required,
    type,
    physician_access,
    fhir_uuid
) VALUES (
    CONVERT(NVARCHAR(40), NEWID()),
    0,
    'hme',
    1,
    NEWID()
);
DECLARE @organisation_id BIGINT;
SELECT @organisation_id = SCOPE_IDENTITY();

INSERT INTO address (
    address_line1,
    city_suburb,
    postcode,
    state_id,
    country_code
) VALUES (
    CONVERT(NVARCHAR(40), NEWID()),
    'Madison',
    '53703',
    390,
    'us'
);
DECLARE @address_id BIGINT;
SELECT @address_id=SCOPE_IDENTITY();

INSERT INTO location (
    active,
    name,
    organisation_id
) VALUES (
    1,
    CONVERT(NVARCHAR(40), NEWID()),
    @organisation_id
);
DECLARE @location_id BIGINT;
SELECT @location_id=SCOPE_IDENTITY();

INSERT INTO easycare_user (
    first_name,
    last_name,
    all_locations,
    last_password_change_date,
    license_agreement_accepted,
    password,
    password_set,
    temporary_password,
    username,
    organisation,
    failed_login_attempts,
    app_easycare_user_seckey,
    fhir_uuid
) VALUES (
    CONVERT(NVARCHAR(40), NEWID()),
    CONVERT(NVARCHAR(40), NEWID()),
    0,
    GETUTCDATE(),
    1,
    CONVERT(NVARCHAR(40), NEWID()),
    1,
    0,
    CONVERT(NVARCHAR(40), NEWID()),
    @organisation_id,
    0,
    NEWID(),
    NEWID()
);
DECLARE @clinical_user_id BIGINT;
SELECT @clinical_user_id=SCOPE_IDENTITY();

DECLARE @patient_avn_id UNIQUEIDENTIFIER;
SET @patient_avn_id = NEWID();
INSERT INTO patient_avn (
    id,
    airview_number
) VALUES (
    @patient_avn_id,
    left(REPLACE(NEWID(),'-',''),11)
);
SET ANSI_WARNINGS OFF;
INSERT INTO patient (
    first_name,
    last_name,
    dob,
    easy_care_number,
    leak_limit,
    monitoring_indefinitely,
    compliance_days,
    setup_date,
    status,
    usage_last30days,
    usage_total_compliant_days,
    usage_total_days,
    clinical_user_id,
    location_id,
    patient_avn_id
) VALUES (
    CONVERT(NVARCHAR(50), NEWID()),
    CONVERT(NVARCHAR(50), NEWID()),
    GETUTCDATE(),
    CONVERT(NVARCHAR(40), NEWID()),
    1,
    0,
    10,
    GETUTCDATE(),
    0,
    10,
    10,
    10,
    @clinical_user_id,
    @location_id,
    @patient_avn_id
);
SET ANSI_WARNINGS ON;

SELECT SCOPE_IDENTITY();

*/