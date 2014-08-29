define('app/controllers/graphs', ['app/models/stats_request', 'ember'],
    //
    //  Graphs Controller
    //
    //  @returns Class
    //
    function (StatsRequest) {

        'use strict';

        return Ember.ArrayController.extend({


            //
            //
            //  Properties
            //
            //


            isOpen: null,
            content: null,
            isPolling: null,
            pollingMethod: null,
            pendingRequests: [],

            config: {
                requestMethod: 'XHR',
                timeWindow: 10 * TIME_MAP.MINUTE,
                measurementStep: 10 * TIME_MAP.SECOND,
                pollingInterval: 10 * TIME_MAP.SECOND,
                measurementOffset: 40 * TIME_MAP.SECOND,
            },


            //
            //
            //  Methods
            //
            //


            open: function (args) {
                this._clear();
                this.setProperties({
                    'isOpen': true,
                    'content': args.graphs,
                });
                Ember.run.next(this, function () {
                    this.stream();
                });
            },


            close: function () {
                this.stopStreaming();
                this._clear();
            },


            toggleStreaming: function () {
                if (this.isStreaming)
                    this.stopStreaming();
                else
                    this.stream();
            },


            stream: function () {
                this.set('isStreaming', true);
                this._fetchStats({
                    from: Date.now() - this.config.timeWindow,
                    until: Date.now()
                });
                this.content.forEach(function (graph) {
                    graph.view.enableAnimation();
                });
            },


            stopStreaming: function () {
                this.set('pendingRequests', []);
                this.set('isStreaming', false);
                this.content.forEach(function (graph) {
                    graph.view.disableAnimation();
                });
            },


            goBack: function () {
                this.stopStreaming();
                this._fetchStats({
                    from: this.fetchStatsArgs.from - this.config.timeWindow,
                    until: this.fetchStatsArgs.from
                });
            },


            goForward: function () {

                // If user can no longer go forward, start streaming
                if (this._isInFuture(this.fetchStatsArgs.until)) {
                    this.stream();
                    return;
                }

                this._fetchStats({
                    from: this.fetchStatsArgs.until,
                    until: this.fetchStatsArgs.until + this.config.timeWindow
                });
            },


            changeTimeWindow: function (newTimeWindow) {
                info(newTimeWindow);
                var oldTimeWindow = this.config.timeWindow;

                if (oldTimeWindow == newTimeWindow)
                    return

                if (newTimeWindow == 'minutes')
                    this.config.timeWindow = 10 * TIME_MAP.MINUTE;
                if (newTimeWindow == 'hour')
                    this.config.timeWindow = TIME_MAP.HOUR;
                if (newTimeWindow == 'day')
                    this.config.timeWindow = TIME_MAP.DAY;
                if (newTimeWindow == 'week')
                    this.config.timeWindow = TIME_MAP.WEEK;
                if (newTimeWindow == 'month')
                    this.config.timeWindow = TIME_MAP.MONTH;

                newTimeWindow = this.config.timeWindow;

                this.content.forEach(function (graph) {
                    graph.view.changeTimeWindow(newTimeWindow);
                });

                var oldFrom = this.isStreaming ? this.fetchStatsArgs.until - oldTimeWindow : this.fetchStatsArgs.from;
                var oldUntil = this.fetchStatsArgs.until;

                // Recalculate time boundaries
                var middle = oldFrom - ((oldFrom - oldUntil) / 2);
                var newFrom = middle + (newTimeWindow / 2);
                var newUntil = middle - (newTimeWindow / 2);

                if (this._isInFuture(newUntil)) {
                    newUntil = Date.now()
                    newFrom = Date.now() - newTimeWindow;
                }
                this.stopStreaming();
                this._fetchStats({
                    from: newFrom,
                    until: newUntil,
                });
            },


            //
            //
            //  Pseudo-Private Methods
            //
            //


            _clear: function () {
                this.setProperties({
                    'isOpen': null,
                    'content': null,
                    'isStreaming': null,
                });
            },


            _isInFuture: function (until) {
                return Date.now() - until <= this.config.timeWindow;
            },


            _fetchStats: function (args) {

                if (this.isClosed) return;

                this.set('fetchStatsArgs', args);
                this.set('pendingRequests', []);

                var requests = this._generateRequests(args);
                requests.forEach(function (request) {
                    this.pendingRequests.push(request);
                    if (this.config.requestMethod == 'XHR')
                        this._fetchStatsFromXHR(request);
                    if (this.config.requestMethod == 'Socket')
                        this._fetchStatsFromSocket(request);
                }, this);
            },


            _generateRequests: function (args) {

                var now = Date.now();
                var requests = [];
                var offset = this.config.measurementOffset;
                this.content.forEach(function (graph) {
                    graph.datasources.forEach(function (datasource) {
                        var newRequest = StatsRequest.create({
                            from: (args ? args.from : datasource.getLastTimestamp()) - offset,
                            until: (args ? args.until : now) - offset,
                            datasources: [datasource],
                        });
                        // Try to merge this request with another
                        // one to reduce API calls
                        var didMerge = false;
                        requests.some(function (request) {
                            if (request.canMerge(newRequest)) {
                                request.merge(newRequest);
                                return didMerge = true;
                            }
                        });
                        if (!didMerge)
                            requests.push(newRequest);
                    });
                });
                return requests;
            },


            _fetchStatsFromXHR: function (request) {
                $.ajax({
                    type: 'GET',
                    url: request.url,
                    data: this._generatePayload(request),
                    complete: this._handleXHRResponse
                });
            },


            _fetchStatsFromSocket: function (request) {
                var data = this._generatePayload(request);
                var machine = request.datasources[0].machine;
                Mist.socket.emit('stats',
                    machine.backend.id,
                    machine.id,
                    data.start,
                    data.stop,
                    data.step,
                    request.id,
                    request.metrics
                );
            },


            _generatePayload: function (request) {
                return {
                    v: 2,
                    request_id: request.id,
                    start: parseInt(request.from / 1000) - 50,
                    stop: parseInt(request.until / 1000) + 50,
                    step: parseInt(this.config.measurementStep / 1000),
                    metrics: request.metrics
                };
            },


            _handleXHRResponse: function (jqXHR) {
                var that = Mist.graphsController;
                if (jqXHR.status == 200) {
                    var response = jqXHR.responseJSON;
                    var request = that.pendingRequests.findBy(
                        'id', parseInt(response.request_id));
                    if (request)
                        that._handleResponse(request, response);
                } else {
                    Ember.run.later(function () {
                        that._fetchStats(that.fetchStatsArgs);
                    }, that.config.pollingInterval / 2);
                }
            },


            _handleSocketResponse: function (data) {
                var that = Mist.graphsController;
                var request = that.pendingRequests.findBy(
                    'id', parseInt(data.request_id));
                if (request)
                    that._handleResponse(request, data.metrics);
            },


            _handleResponse: function (request, response) {

                var processedDatapoints =
                request.datasources.forEach(function (datasource) {

                    var datapoints = this._processedDatapoints(request,
                        response[datasource.metric.id].datapoints);

                    if (this.isStreaming)
                        datasource.update(datapoints);
                    else
                        datasource.overwrite(datapoints);

                }, this);

                this.pendingRequests.removeObject(request);

                if (!this.pendingRequests.length)
                    this._fetchStatsEnded();
            },


            _processedDatapoints: function (request, datapoints) {
                var newDatapoints = [];
                datapoints.forEach(function (datapoint) {
                    if (datapoint[1] >= parseInt(request.from / 1000) &&
                        datapoint[1] <= parseInt(request.until / 1000))
                            newDatapoints.push(datapoint);
                }, this);
                return newDatapoints;
            },


            _fetchStatsEnded: function () {
                this.content.forEach(function (graph) {
                    graph.view.draw();
                });
                Ember.run.later(this, function () {
                    if (this.isStreaming)
                        this._fetchStats();
                }, this.config.pollingInterval);
            }
        });
    }
);
