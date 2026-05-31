(function () {
  if (window.__smartAlignPluginLoaded) return;
  window.__smartAlignPluginLoaded = true;

  var React = window.React;
  var PluginsAPI = window.PluginsAPI;
  var SHOW_SMARTALIGN_TASK_BUTTON = true;

  function hasOrthophoto(task) {
    return task && Array.isArray(task.available_assets) && task.available_assets.indexOf("orthophoto.tif") !== -1;
  }

  function openSmartpoint(task) {
    if (!task || !task.project || !task.id) return;
    window.location.href = "/plugins/Smartpoint/align/project/" + encodeURIComponent(task.project) + "/task/" + encodeURIComponent(task.id) + "/";
  }

  function statusUrl(task) {
    return "/plugins/Smartpoint/api/project/" + encodeURIComponent(task.project) + "/task/" + encodeURIComponent(task.id) + "/status/";
  }

  class SmartAlignTaskButton extends React.Component {
    constructor(props) {
      super(props);
      this.state = {
        bound: null
      };
    }

    componentDidMount() {
      this.mounted = true;
      this.loadStatus();
    }

    componentWillUnmount() {
      this.mounted = false;
    }

    loadStatus() {
      var task = this.props.task;
      if (!task || !window.fetch) return;
      window.fetch(statusUrl(task), { credentials: "same-origin" })
        .then(function (response) {
          if (!response.ok) throw new Error("status failed");
          return response.json();
        })
        .then((json) => {
          if (!this.mounted || !json || !json.success) return;
          this.setState({ bound: json.smartpoint_bound === true });
        })
        .catch(() => {});
    }

    render() {
      var task = this.props.task;
      var warning = this.state.bound === false;
      return React.createElement(
        "button",
        {
          className: "btn " + (warning ? "btn-warning" : "btn-default") + " btn-sm smartalign-task-button",
          type: "button",
          title: "Прив'язка до місцевості",
          onClick: function () { openSmartpoint(task); }
        },
        React.createElement("i", { className: "fa fa-magic" }),
        " Прив'язка до місцевості"
      );
    }
  }

  if (!React || !PluginsAPI || !PluginsAPI.Dashboard) return;

  PluginsAPI.Dashboard.addTaskActionButton(function (args) {
    if (!SHOW_SMARTALIGN_TASK_BUTTON) return null;
    var task = args && args.task;
    if (!hasOrthophoto(task)) return null;

    return React.createElement(SmartAlignTaskButton, { task: task });
  });
})();



