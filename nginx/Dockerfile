FROM owasp/modsecurity-crs:nginx-alpine

USER root

COPY nginx.conf /etc/nginx/nginx.conf

COPY certs/cert.pem /etc/nginx/certs/cert.pem

COPY certs/key.pem /etc/nginx/certs/key.pem

COPY modsecurity.conf /etc/nginx/modsecurity.d/modsecurity.conf

COPY crs-setup.conf /etc/nginx/modsecurity.d/owasp-crs/crs-setup.conf

RUN mkdir -p /var/log/modsecurity && chown -R nginx:nginx /var/log/modsecurity


EXPOSE 443
ENTRYPOINT []
CMD ["nginx", "-g", "daemon off;"]