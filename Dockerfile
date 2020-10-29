FROM node:12
WORKDIR /app
COPY package*.json *.js /app/
# RUN npm install
RUN npm ci --only=production
EXPOSE 3030
ENV JIRA_HOST=company.atlassian.net
ENV JIRA_USERNAME=username@company.net
ENV JIRA_PASSWORD=gobbledygook
CMD [ "npm", "start" ]