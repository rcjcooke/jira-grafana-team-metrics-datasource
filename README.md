# jira-grafana-team-metrics-datasource
Grafana Datasource that connects to JIRA and analyses data to produce team management metrics such as velocity and cycle time

## Development / Usage
* Create a .env file like the .env-example file but with your JIRA credentials (the password is the key you generate from your atlassian account, not your actual password)
* If using VS Code, run a debug session using the "Launch via npm" configuration
* From the command link run it with npm using `npm start`

## Dashboard query configuration
Many of the queries the service supports have required and optional parameters supplied using custom JSON input data such as in the image below.

![JSON Config Data Example Screenshot](docs/JSONConfigDataExample.png)

The configuration options for each metric are specified here.

### Current 2 week velocity

Example: `{"toStatus": "Deployed", "projectKey": "ENG"}`

| Key | Description | Possible Values | Descriptions |
| --- | ----------- | --------------- | ------------ |
| toStatus | The status the velocity calculation considers to be "complete" | Any status in the value stream | The name of the status |
| projectKey | The project for which velocity is being calculated. Only issues that are part of the specified project at the time of completion count towards the velocity | Any JIRA project key | The JIRA project key |

### Rolling 2 week velocity

Example: `{"toStatus": "Deployed", "projectKey": "ENG"}`

| Key | Description | Possible Values | Descriptions |
| --- | ----------- | --------------- | ------------ |
| toStatus | The status the velocity calculation considers to be "complete" | Any status in the value stream | The name of the status |
| projectKey | The project for which velocity is being calculated. Only issues that are part of the specified project at the time of completion count towards the velocity | Any JIRA project key | The JIRA project key |



## Running on a Raspberry PI

Make aure the Simple JSON plugin is installed on your grafana instance:

`sudo grafana-cli plugins install simpod-json-datasource`

Set up the datasource:

1. Add new datasource in the Grafana UI
2. Name: JSON
3. URL: http://localhost:3030
4. Everything else turned off

Set up the dashboard:

1. Go to manage dashboards on the Grafana UI
2. Click "Upload JSON"
3. Navigate to the json file in the grafana sub-directory of this project on your lcoal machine and import it

To run this as a service on a rasperry pi:

1. `sudo cp jira-metrics.service /etc/systemd/system/`
2. `sudo chmod u+rwx /etc/systemd/system/jira-metrics.service`
3. `sudo systemctl enable jira-metrics`

To control the service manually:

*Start*: sudo systemctl start jira-metrics
*Stop*: sudo systemctl stop jira-metrics

To see the output log:

`cat /var/log/syslog`